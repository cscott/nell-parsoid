/**
 * Command line parse utility.
 * Read from STDIN, write to STDOUT.
 *
 * @author Neil Kandalgaonkar <neilk@wikimedia.org>
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */

var ParserPipelineFactory = require('../lib/mediawiki.parser.js').ParserPipelineFactory,
	ParserEnv = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig.js' ).ParsoidConfig,
	ConvertDOMToLM = require('../lib/mediawiki.LinearModelConverter.js').ConvertDOMToLM,
	WikitextSerializer = require('../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( '../lib/mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	Util = require('../lib/mediawiki.Util.js').Util,
	optimist = require('optimist'),
	fs = require('fs');

function traceUsage() {
	var buf = [];
	buf.push("Tracing");
	buf.push("-------");
	buf.push("- Without any flags, enables a light high-level tracing (not as useful anymore)");
	buf.push("- With one or more comma-separated flags, traces those specific phases");
	buf.push("- Supported flags:");
	buf.push("  * sync:1    : shows tokens flowing through the post-tokenizer Sync Token Transform Manager");
	buf.push("  * async:2   : shows tokens flowing through the Async Token Transform Manager");
	buf.push("  * sync:3    : shows tokens flowing through the post-expansion Sync Token Transform Manager");
	buf.push("  * list      : shows actions of the list handler");
	buf.push("  * pre       : shows actions of the pre handler");
	buf.push("  * pre_debug : shows actions of the pre handler + tokens returned from it");
	buf.push("  * p-wrap    : shows actions of the paragraph wrapper");
	buf.push("  * html      : shows tokens that are sent to the HTML tree builder");
	buf.push("  * dsr       : shows dsr computation on the DOM");
	buf.push("  * wts       : trace actions of the regular wikitext serializer");
	buf.push("  * selser    : trace actions of the selective serializer\n");
	buf.push("--debug enables tracing of all the above phases except Token Transform Managers\n");
	buf.push("Examples:");
	buf.push("$ node parse --trace pre,p-wrap,html < foo");
	buf.push("$ node parse --trace sync:3,dsr < foo");
	return buf.join('\n');
}

function dumpFlags() {
	var buf = [];
	buf.push("Dumping state");
	buf.push("-------------");
	buf.push("- Dumps state at different points of execution");
	buf.push("- DOM dumps are always doc.outerHTML");
	buf.push("- Supported flags:");
	buf.push("  * dom:post-builder  : dumps DOM returned by HTML builder");
	buf.push("  * dom:pre-dsr       : dumps DOM prior to computing DSR");
	buf.push("  * dom:post-dsr      : dumps DOM after computing DSR");
	buf.push("  * dom:pre-encap     : dumps DOM before template encapsulation");
	buf.push("  * dom:serialize-ids : in selective serialization, dumps DOM after assigning serializer ids\n");
	buf.push("--debug dumps state at these different stages\n");
	buf.push("Examples:");
	buf.push("$ node parse --dump dom:post-builder,dom:pre-dsr,dom:pre-encap < foo");
	buf.push("$ node parse --trace html --dump dom:pre-encap < foo");
	buf.push("\n");
	return buf.join('\n');
}

( function() {
	var default_mode_str = "Default conversion mode : --wt2html";
	var opts = optimist.usage( 'Usage: echo wikitext | $0 [options]\n\n' + default_mode_str, {
		'help': {
			description: 'Show this message',
			'boolean': true,
			'default': false
		},
		'wt2html': {
			description: 'Wikitext -> HTML',
			'boolean': true,
			'default': false
		},
		'html2wt': {
			description: 'HTML -> Wikitext',
			'boolean': true,
			'default': false
		},
		'wt2wt': {
			description: 'Wikitext -> HTML -> Wikitext',
			'boolean': true,
			'default': false
		},
		'html2html': {
			description: 'HTML -> Wikitext -> HTML',
			'boolean': true,
			'default': false
		},
		'selser': {
			description: 'Use the selective serializer to go from HTML to Wikitext.',
			'boolean': true,
			'default': false
		},
		'linearmodel': {
			description: 'Output linear model data instead of HTML',
			'boolean': true,
			'default': false
		},
		'debug': {
			description: 'Debug mode',
			'boolean': true,
			'default': false
		},
		'trace [optional-flags]': {
			description: 'Trace tokens (see below for supported trace options)',
			'boolean': true,
			'default': false
		},
		'dump <flags>': {
			description: 'Dump state (see below for supported dump flags)',
			'boolean': false,
			'default': ""
		},
		'maxdepth': {
			description: 'Maximum expansion depth',
			'boolean': false,
			'default': 40
		},
		'prefix': {
			description: 'Which wiki prefix to use; e.g. "en" for English wikipedia, "es" for Spanish, "mw" for mediawiki.org',
			'boolean': false,
			'default': ''
		},
		'apiURL': {
			description: 'http path to remote API, e.g. http://en.wikipedia.org/w/api.php',
			'boolean': false,
			'default': null
		},
		'fetchTemplates': {
			description: 'Whether to fetch included templates recursively',
			'boolean': true,
			'default': true
		},
		'usephppreprocessor': {
			description: 'Whether to use the PHP preprocessor to expand templates and extensions',
			'boolean': true,
			'default': true
		},
		'pagename': {
			description: 'The page name, returned for {{PAGENAME}}.',
			'boolean': false,
			'default': 'Main page'
		},
		'oldtext': {
			description: 'The old page text for a selective-serialization operation (see --selser)',
			'boolean': false,
			'default': false
		},
		'oldtextfile': {
			description: 'File containing the old page text for a selective-serialization operation (see --selser)',
			'boolean': false,
			'default': false
		}
	});

	var argv = opts.argv;

	if ( argv.help ) {
		optimist.showHelp();
		console.error(traceUsage());
		console.error("\n");
		console.error(dumpFlags());
		return;
	}

	// Default conversion mode
	if (!argv.html2wt && !argv.wt2wt && !argv.html2html) {
		argv.wt2html = true;
	}

	var prefix = argv.prefix || null;

	if (argv.apiURL) {
		parsoidConfig.setInterwiki( 'customwiki', argv.apiURL );
		prefix = 'customwiki';
	}

	var parsoidConfig = new ParsoidConfig( null, { defaultWiki: prefix } );

	ParserEnv.getParserEnv( parsoidConfig, null, prefix, argv.pagename || null, function ( err, env ) {
		if ( err !== null ) {
			console.error( err.toString() );
			process.exit( 1 );
		}

		// fetch templates from enwiki by default.
		if ( argv.wgScriptPath ) {
			env.conf.wiki.wgScriptPath = argv.wgScriptPath;
		}

		// XXX: add options for this!
		env.conf.parsoid.fetchTemplates = argv.fetchTemplates;
		env.conf.parsoid.usePHPPreProcessor = env.conf.parsoid.fetchTemplates && argv.usephppreprocessor;
		env.conf.parsoid.maxDepth = argv.maxdepth || env.conf.parsoid.maxDepth;

		Util.setDebuggingFlags( env.conf.parsoid, argv );

		// Init parsers, serializers, etc.
		var parserPipeline,
			serializer;
		if (!argv.html2wt) {
			var parserPipelineFactory = new ParserPipelineFactory(env);
			parserPipeline = parserPipelineFactory.makePipeline('text/x-mediawiki/full');
		}
		if (!argv.wt2html) {
			if ( argv.oldtextfile ) {
				argv.oldtext = fs.readFileSync(argv.oldtextfile, 'utf8');
			}
			env.page.src = argv.oldtext || null;
			if ( argv.selser ) {
				serializer = new SelectiveSerializer( { env: env, oldid: null } );
			} else {
				serializer = new WikitextSerializer( { env: env } );
			}
		}

		var stdin = process.stdin,
			stdout = process.stdout,
			inputChunks = [];

		// collect input
		stdin.resume();
		stdin.setEncoding('utf8');
		stdin.on( 'data', function( chunk ) {
			inputChunks.push( chunk );
		} );

		// process input
		stdin.on( 'end', function() {
			var input = inputChunks.join('');
			if (argv.html2wt || argv.html2html) {
				var doc = Util.parseHTML('<html><body>' + input.replace(/\r/g, '') + '</body></html>'),
					wt = '';

				serializer.serializeDOM( doc.body, function ( chunk ) {
					wt += chunk;
				}, function () {
					env.page.src = wt;
					if (argv.html2wt) {
						// add a trailing newline for shell user's benefit
						stdout.write(wt);
					} else {
						parserPipeline.on('document', function(document) {
							stdout.write( Util.serializeNode(document.body) );
						});
						parserPipeline.process(wt);
					}

					process.exit(0);
				} );
			} else {
				parserPipeline.on('document', function ( document ) {
					var res, finishCb = function (trailingNL) {
						stdout.write( res );
						if (trailingNL) {
							stdout.write("\n");
						}
						process.exit( 0 );
					};
					if (argv.wt2html) {
						res = Util.serializeNode(document.body);
						finishCb(true);
					} else if (argv.wt2wt) {
						res = '';
						serializer.serializeDOM( document.body, function ( chunk ) {
							res += chunk;
						}, finishCb );
					} else { // linear model
						res = JSON.stringify( ConvertDOMToLM( document.body ), null, 2 );
						finishCb();
					}
				});

				// Kick off the pipeline by feeding the input into the parser pipeline
				env.page.src = input;
				parserPipeline.process( input );
			}
		} );
	} );
} )();
