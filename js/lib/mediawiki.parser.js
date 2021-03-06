"use strict";
/**
 * This module assembles parser pipelines from parser stages with
 * asynchronous communnication between stages based on events. Apart from the
 * default pipeline which converts WikiText to HTML DOM, it also provides
 * sub-pipelines for the processing of template transclusions.
 *
 * See http://www.mediawiki.org/wiki/Parsoid and
 * http://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for illustrations of the pipeline architecture.
 */

// make this global for now
// XXX: figure out a way to get away without a global for PEG actions!
var $ = require('./fakejquery'),
	events = require( 'events' ),

	fs = require('fs'),
	path = require('path'),
	PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	TokenTransformManager = require('./mediawiki.TokenTransformManager.js'),
	SyncTokenTransformManager = TokenTransformManager.SyncTokenTransformManager,
	AsyncTokenTransformManager = TokenTransformManager.AsyncTokenTransformManager,

	NoIncludeOnly = require('./ext.core.NoIncludeOnly.js'),
	IncludeOnly = NoIncludeOnly.IncludeOnly,
	NoInclude = NoIncludeOnly.NoInclude,
	OnlyInclude	= NoIncludeOnly.OnlyInclude,
	ExtensionContent = require('./ext.ExtensionContentCollector.js').ExtensionContent,
	QuoteTransformer = require('./ext.core.QuoteTransformer.js').QuoteTransformer,
	TokenStreamPatcher = require('./ext.core.TokenStreamPatcher.js').TokenStreamPatcher,
	PreHandler = require('./ext.core.PreHandler.js').PreHandler,
	ParagraphWrapper = require('./ext.core.ParagraphWrapper.js').ParagraphWrapper,
	Sanitizer = require('./ext.core.Sanitizer.js').Sanitizer,
	TemplateHandler = require('./ext.core.TemplateHandler.js').TemplateHandler,
	AttributeExpander = require('./ext.core.AttributeExpander.js').AttributeExpander,
	ListHandler = require('./ext.core.ListHandler.js').ListHandler,
	LinkHandler = require('./ext.core.LinkHandler.js'),
	WikiLinkHandler	= LinkHandler.WikiLinkHandler,
	ExternalLinkHandler	= LinkHandler.ExternalLinkHandler,
	Cite = require('./ext.Cite.js').Cite,
	BehaviorSwitch = require('./ext.core.BehaviorSwitchHandler.js'),
	BehaviorSwitchHandler = BehaviorSwitch.BehaviorSwitchHandler,
	BehaviorSwitchPreprocessor = BehaviorSwitch.BehaviorSwitchPreprocessor,
	TreeBuilder = require('./mediawiki.HTML5TreeBuilder.node.js')
													.FauxHTML5.TreeBuilder,
	DOMPostProcessor = require('./mediawiki.DOMPostProcessor.js').DOMPostProcessor;


function ParserPipelineFactory ( env ) {
	this.pipelineCache = {};
	this.env = env;
}

/**
 * Recipe for parser pipelines and -subpipelines, depending on input types.
 *
 * Token stream transformations to register by type and per phase. The
 * possible ranks for individual transformation registrations are [0,1)
 * (excluding 1.0) for sync01, [1,2) for async12 and [2,3) for sync23.
 *
 * Should perhaps be moved to mediawiki.parser.environment.js, so that all
 * configuration can be found in a single place.
 */

// These handlers are used in two different recipes
var postExpansionHandlers = [
	TokenStreamPatcher,	    // 2.001 -- 2.003
		// add <pre>s
	PreHandler,				// 2.051 -- 2.054
	QuoteTransformer,		// 2.1
		// add before transforms that depend on behavior switches
		// examples: toc generation, edit sections
	BehaviorSwitchHandler,	// 2.14

	ListHandler,			// 2.49
	Sanitizer,          	// 2.90, 2.91
		// Wrap tokens into paragraphs post-sanitization so that
		// tags that converted to text by the sanitizer have a chance
		// of getting wrapped into paragraphs.  The sanitizer does not
		// require the existence of p-tags for its functioning.
	ParagraphWrapper, 	// 2.95 -- 2.97
];

ParserPipelineFactory.prototype.recipes = {
	// The full wikitext pipeline
	'text/x-mediawiki/full': [
		// Input pipeline including the tokenizer
		'text/x-mediawiki',
		// Final synchronous token transforms and DOM building / processing
		'tokens/x-mediawiki/expanded'
	],

	// A pipeline from wikitext to expanded tokens. The input pipeline for
	// wikitext.
	'text/x-mediawiki': [
		[ PegTokenizer, [] ],
		'tokens/x-mediawiki'
	],

	'tokens/x-mediawiki/post-expansion': [
		[
			SyncTokenTransformManager,
			[ 3, 'tokens/x-mediawiki/post-expansion' ],
			postExpansionHandlers
		]
	],

	// Synchronous per-input and async token stream transformations. Produces
	// a fully expanded token stream ready for consumption by the
	// tokens/expanded pipeline.
	'tokens/x-mediawiki': [
		// Synchronous in-order per input
		[
			SyncTokenTransformManager,
			[ 1, 'tokens/x-mediawiki' ],
			[
				// PHASE RANGE: [0,1)
				OnlyInclude,	// 0.01
				IncludeOnly,	// 0.02
				NoInclude,		// 0.03
				ExtensionContent, // 0.04

				// Preprocess behavior switches
				BehaviorSwitchPreprocessor, // 0.05
			]
		],
		/*
		* Asynchronous out-of-order per input. Each async transform can only
		* operate on a single input token, but can emit multiple output
		* tokens. If multiple tokens need to be collected per-input, then a
		* separate collection transform in sync01 can be used to wrap the
		* collected tokens into a single one later processed in an async12
		* transform.
		*/
		[
			AsyncTokenTransformManager,
			[ 2, 'tokens/x-mediawiki' ],
			[
				// PHASE RANGE: [1,2)

				TemplateHandler,	// 1.1
				/* ExtensionHandler1, */ // using SFH_OBJECT_ARGS in PHP

				// Expand attributes after templates to avoid expanding unused branches
				// No expansion of quotes, paragraphs etc in attributes, as in
				// PHP parser- up to text/x-mediawiki/expanded only.
				AttributeExpander,	// 1.11

				// now all attributes expanded to tokens or string

				// more convenient after attribute expansion
				WikiLinkHandler,	// 1.15

				ExternalLinkHandler // 1.15
				/* ExtensionHandler2, */ // using expanded args
				// Finally expand attributes to plain text
			]
		]
	],

	// Final stages of main pipeline, operating on fully expanded tokens of
	// potentially mixed origin.
	'tokens/x-mediawiki/expanded': [
		// Synchronous in-order on fully expanded token stream (including
		// expanded templates etc). In order to support mixed input (from
		// wikitext and plain HTML, say) all applicable transforms need to be
		// included here. Input-specific token types avoid any runtime
		// overhead for unused transforms.
		[
			SyncTokenTransformManager,
				// PHASE RANGE: [2,3)
			[ 3, 'tokens/x-mediawiki/expanded' ],
			[
				// Cite should be the first thing to run so the <ref>-</ref>
				// content tokens are pulled out of the token stream and
				// dont pollute the main token stream with any unbalanced
				// tags/pres and the like.
				//
				// RANK: 2.01, 2.99
				//
				// Cite + all other handlers
				Cite
			].concat(postExpansionHandlers)
		],

		// Build a tree out of the fully processed token stream
		[ TreeBuilder, [] ],

		/**
		* Final processing on the HTML DOM.
		*/

		/* Generic DOM transformer.
		* This currently performs minor tree-dependent clean up like wrapping
		* plain text in paragraphs. For HTML output, it would also be configured
		* to perform more aggressive nesting cleanup.
		*/
		[ DOMPostProcessor, [] ]
	]
};

// SSS FIXME: maybe there is some built-in method for this already?
// Default options processing
ParserPipelineFactory.prototype.defaultOptions = function(options) {
	if (!options) {
		options = {};
	}

	// default: not an include context
	if (options.isInclude === undefined) {
		options.isInclude = false;
	}

	// default: wrap templates
	if (options.wrapTemplates === undefined) {
		options.wrapTemplates = true;
	}

	return options;
};

/**
 * Generic pipeline creation from the above recipes
 */
ParserPipelineFactory.prototype.makePipeline = function( type, options ) {
	// SSS FIXME: maybe there is some built-in method for this already?
	options = this.defaultOptions(options);

	var recipe = this.recipes[type];
	if ( ! recipe ) {
		console.trace();
		throw( 'Error while trying to construct pipeline for ' + type );
	}
	var stages = [];
	for ( var i = 0, l = recipe.length; i < l; i++ ) {
		// create the stage
		var stageData = recipe[i],
			stage;

		if ( stageData.constructor === String ) {
			// Points to another subpipeline, get it recursively
			// Clone options object and clear cache type
			var newOpts = $.extend({}, options);
			newOpts.cacheType = null;
			stage = this.makePipeline( stageData, newOpts);
		} else {
			stage = Object.create( stageData[0].prototype );
			// call the constructor
			stageData[0].apply( stage, [ this.env, options, this ].concat( stageData[1] ) );
			if ( stageData.length >= 3 ) {
				// Create (and implicitly register) transforms
				var transforms = stageData[2];
				for ( var t = 0; t < transforms.length; t++ ) {
					new transforms[t](stage , options);
				}
			}
		}

		// connect with previous stage
		if ( i ) {
			stage.addListenersOn( stages[i-1] );
		}
		stages.push( stage );
	}
	//console.warn( 'stages' + stages + JSON.stringify( stages ) );
	return new ParserPipeline(
			stages[0],
			stages[stages.length - 1],
			options.cacheType ? this.returnPipeline.bind( this, options.cacheType )
						: null,
			this.env
			);
};

function getCacheKey(cacheType, options) {
	if ( ! options.isInclude ) {
		cacheType += '::noInclude';
	}
	if ( ! options.wrapTemplates ) {
		cacheType += '::noWrap';
	}
	if ( options.inBlockToken ) {
		cacheType += '::inBlockToken';
	}
	return cacheType;
}

/**
 * Get a subpipeline (not the top-level one) of a given type.
 *
 * Subpipelines are cached as they are frequently created.
 */
ParserPipelineFactory.prototype.getPipeline = function ( type, options ) {
	if (!options) {
		options = {};
	}

	if ( options.isInclude === undefined ) {
		// default to include
		options.isInclude = true;
	}

	var pipe,
		cacheType = getCacheKey(type, options);
	if ( ! this.pipelineCache[cacheType] ) {
		this.pipelineCache[cacheType] = [];
	}
	if ( this.pipelineCache[cacheType].length ) {
		//console.warn( JSON.stringify( this.pipelineCache[cacheType] ));
		return this.pipelineCache[cacheType].pop();
	} else {
		options.cacheType = cacheType;
		return this.makePipeline( type, options );
	}
};

/**
 * Callback called by a pipeline at the end of its processing. Returns the
 * pipeline to the cache.
 */
ParserPipelineFactory.prototype.returnPipeline = function ( type, pipe ) {
	pipe.removeAllListeners( 'end' );
	pipe.removeAllListeners( 'chunk' );
	var cache = this.pipelineCache[type];
	if ( cache.length < 8 ) {
		cache.push( pipe );
	}
};


/******************** ParserPipeline ****************************/

/**
 * Wrap some stages into a pipeline. The last member of the pipeline is
 * supposed to emit events, while the first is supposed to support a process()
 * method that sets the pipeline in motion.
 */
function ParserPipeline ( first, last, returnToCacheCB, env ) {
	this.first = first;
	this.last = last;
	this.env = env;

	if ( returnToCacheCB ) {
		var self = this;
		this.returnToCacheCB = function () {
			returnToCacheCB( self );
		};

		// add a callback to return the pipeline back to the cache
		this.last.addListener( 'end', this.returnToCacheCB );
	}
}

/**
 * Feed input tokens to the first pipeline stage
 */
ParserPipeline.prototype.process = function(input, key) {
	try {
		return this.first.process(input, key);
	} catch ( err ) {
		this.env.errCB( err );
	}
};

/**
 * Set the frame on the last pipeline stage (normally the
 * AsyncTokenTransformManager).
 */
ParserPipeline.prototype.setFrame = function(frame, title, args) {
	return this.last.setFrame(frame, title, args);
};

/**
 * Register the first pipeline stage with the last stage from a separate pipeline
 */
ParserPipeline.prototype.addListenersOn = function(stage) {
	return this.first.addListenersOn(stage);
};

// Forward the EventEmitter API to this.last
ParserPipeline.prototype.on = function (ev, cb) {
	return this.last.on(ev, cb);
};
ParserPipeline.prototype.once = function (ev, cb) {
	return this.last.once(ev, cb);
};
ParserPipeline.prototype.addListener = function(ev, cb) {
	return this.last.addListener(ev, cb);
};
ParserPipeline.prototype.removeListener = function(ev, cb) {
	return this.last.removeListener(ev, cb);
};
ParserPipeline.prototype.setMaxListeners = function(n) {
	return this.last.setMaxListeners(n);
};
ParserPipeline.prototype.listeners = function(ev) {
	return this.last.listeners(ev);
};
ParserPipeline.prototype.removeAllListeners = function ( event ) {
	if ( event === 'end' ) {
		this.last.removeAllListeners('end');
		// now re-add the cache callback
		if ( this.returnToCacheCB ) {
			this.last.addListener( 'end', this.returnToCacheCB );
		}
	} else {
		return this.last.removeAllListeners( event );
	}
};

if (typeof module === "object") {
	module.exports.ParserPipeline = ParserPipeline;
	module.exports.ParserPipelineFactory = ParserPipelineFactory;
}
