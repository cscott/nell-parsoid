/**
 * A very basic parser / serializer web service.
 *
 * Local configuration:
 *
 * To configure locally, add localsettings.js to this directory and export a setup function.
 *
 * @example
 *	exports.setup = function( config, env ) {
 *		env.setInterwiki( 'localhost', 'http://localhost/wiki' );
 *	};
 */

/**
 * Config section
 *
 * Could move this to a separate file later.
 */

var config = {};

/**
 * End config section
 */

// global includes
var express = require('express'),
	jsDiff = require('diff'),
	childProc = require('child_process'),
	spawn = childProc.spawn,
	fork = childProc.fork,
	path = require('path'),
	cluster = require('cluster'),
	fs = require('fs');

// local includes
var mp = '../lib/';

var lsp, localSettings;

try {
	lsp = __dirname + '/localsettings.js';
	localSettings = require( lsp );
} catch ( e ) {
	// Build a skeleton localSettings to prevent errors later.
	localSettings = {
		setup: function ( pconf ) {}
	};
}

var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';

console.log( ' - ' + instanceName + ' loading...' );

var WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	Util = require( mp + 'mediawiki.Util.js' ).Util,
	libtr = require(mp + 'mediawiki.ApiRequest.js'),
	DoesNotExistError = libtr.DoesNotExistError,
	ParserError = libtr.ParserError,
	WikiConfig = require( mp + 'mediawiki.WikiConfig' ).WikiConfig,
	ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig,
	MWParserEnvironment = require( mp + 'mediawiki.parser.environment.js' ).MWParserEnvironment,
	TemplateRequest = libtr.TemplateRequest;

var interwikiRE;

var parsoidConfig = new ParsoidConfig( localSettings, null ),
	Serializer = parsoidConfig.useSelser ? SelectiveSerializer : WikitextSerializer;

function getInterwikiRE() {
	// this RE won't change -- so, cache it
	if (!interwikiRE) {
		interwikiRE = parsoidConfig.interwikiRegexp;
	}
	return interwikiRE;
}

var htmlSpecialChars = function ( s ) {
	return s.replace(/&/g,'&amp;')
		.replace(/</g,'&lt;')
		.replace(/"/g,'&quot;')
		.replace(/'/g,'&#039;');
};

var textarea = function ( res, content ) {
	res.write('<form method=POST><textarea name="content" cols=90 rows=9>');
	res.write( ( content &&
					htmlSpecialChars( content) ) ||
			'');
	res.write('</textarea><br><input type="submit"></form>');
};

/**
 * Perform word-based diff on a line-based diff. The word-based algorithm is
 * practically unusable for inputs > 5k bytes, so we only perform it on the
 * output of the more efficient line-based diff.
 */
var refineDiff = function ( diff ) {
	// Attempt to accumulate consecutive add-delete pairs
	// with short text separating them (short = 2 chars right now)
	//
	// This is equivalent to the <b><i> ... </i></b> minimization
	// to expand range of <b> and <i> tags, except there is no optimal
	// solution except as determined by heuristics ("short text" = <= 2 chars).
	function mergeConsecutiveSegments(wordDiffs) {
		var n = wordDiffs.length,
			currIns = null, currDel = null,
			newDiffs = [];
		for (var i = 0; i < n; i++) {
			var d = wordDiffs[i],
				dVal = d.value;
			if (d.added) {
				// Attempt to accumulate
				if (currIns === null) {
					currIns = d;
				} else {
					currIns.value = currIns.value + dVal;
				}
			} else if (d.removed) {
				// Attempt to accumulate
				if (currDel === null) {
					currDel = d;
				} else {
					currDel.value = currDel.value + dVal;
				}
			} else if (((dVal.length < 4) || !dVal.match(/\s/)) && currIns && currDel) {
				// Attempt to accumulate
				currIns.value = currIns.value + dVal;
				currDel.value = currDel.value + dVal;
			} else {
				// Accumulation ends. Purge!
				if (currIns !== null) {
					newDiffs.push(currIns);
					currIns = null;
				}
				if (currDel !== null) {
					newDiffs.push(currDel);
					currDel = null;
				}
				newDiffs.push(d);
			}
		}

		// Purge buffered diffs
		if (currIns !== null) {
			newDiffs.push(currIns);
		}
		if (currDel !== null) {
			newDiffs.push(currDel);
		}

		return newDiffs;
	}

	var added = null,
		out = [];
	for ( var i = 0, l = diff.length; i < l; i++ ) {
		var d = diff[i];
		if ( d.added ) {
			if ( added ) {
				out.push( added );
			}
			added = d;
		} else if ( d.removed ) {
			if ( added ) {
				var fineDiff = jsDiff.diffWords( d.value, added.value );
				fineDiff = mergeConsecutiveSegments(fineDiff);
				out.push.apply( out, fineDiff );
				added = null;
			} else {
				out.push( d );
			}
		} else {
			if ( added ) {
				out.push( added );
				added = null;
			}
			out.push(d);
		}
	}
	if ( added ) {
		out.push(added);
	}
	return out;
};

var roundTripDiff = function ( req, res, env, document ) {
	var patch;
	var out = [];

	var finalCB =  function () {
		// XXX TODO FIXME BBQ There should be an error callback in SelSer.
		out = out.join('');
		if ( out === undefined ) {
			console.log( 'Serializer error!' );
			out = "An error occured in the WikitextSerializer, please check the log for information";
			res.send( out, 500 );
			return;
		}
		res.write('<html><head>\n');
		res.write('<script type="text/javascript" src="/jquery.js"></script><script type="text/javascript" src="/scrolling.js"></script><style>ins { background: #ff9191; text-decoration: none; } del { background: #99ff7e; text-decoration: none }; </style>\n');
		// Emit base href so all relative urls resolve properly
		var headNodes = document.firstChild.firstChild.childNodes;
		for (var i = 0; i < headNodes.length; i++) {
			if (headNodes[i].nodeName.toLowerCase() === 'base') {
				res.write(Util.serializeNode(headNodes[i]));
				break;
			}
		}
		res.write('</head><body>\n');
		res.write( '<h2>Wikitext parsed to HTML DOM</h2><hr>\n' );
		var bodyNodes = document.body.childNodes;
		for (var i = 0; i < bodyNodes.length; i++) {
			res.write(Util.serializeNode(bodyNodes[i]));
		}
		res.write('\n<hr>');
		res.write( '<h2>HTML DOM converted back to Wikitext</h2><hr>\n' );
		res.write('<pre>' + htmlSpecialChars( out ) + '</pre><hr>\n');
		res.write( '<h2>Diff between original Wikitext (green) and round-tripped wikitext (red)</h2><p>(use shift+alt+n and shift+alt+p to navigate forward and backward)<hr>\n' );
		var src = env.page.src.replace(/\n(?=\n)/g, '\n ');
		out = out.replace(/\n(?=\n)/g, '\n ');
		//console.log(JSON.stringify( jsDiff.diffLines( out, src ) ));
		patch = jsDiff.convertChangesToXML( jsDiff.diffLines( src, out ) );
		//patch = jsDiff.convertChangesToXML( refineDiff( jsDiff.diffLines( src, out ) ) );
		res.write( '<pre>\n' + patch + '\n</pre>');
		// Add a 'report issue' link
		res.write('<hr>\n<h2>'+
				'<a style="color: red" ' +
				'href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo' +
				'&amp;action=edit&amp;section=new&amp;preloadtitle=' +
				'Issue%20on%20http://parsoid.wmflabs.org' + req.url + '">' +
				'Report a parser issue in this page</a> at ' +
				'<a href="http://www.mediawiki.org/wiki/Talk:Parsoid/Todo">'+
				'[[:mw:Talk:Parsoid/Todo]]</a></h2>\n<hr>');
		res.end('\n</body></html>');
	};

	new Serializer({env: env}).serializeDOM( document.body,
				function ( chunk ) {
					out.push(chunk);
				}, finalCB );
};

var parse = function ( env, req, res, cb, err, src ) {
	var newCb = function ( src, err, doc ) {
		if ( err !== null ) {
			if ( !err.code ) {
				err.code = 500;
			}
			console.error( err.stack || err.toString() );
			res.send( err.stack || err.toString(), err.code );
			return;
		} else {
			res.setHeader('Content-Type', 'text/html; charset=UTF-8');
			cb( req, res, src, doc );
		}
	};

	// Set the source
	env.page.src = src;

	Util.parse( env, newCb, err, src );
};

/* -------------------- web app access points below --------------------- */

var app = express.createServer();
app.use(express.bodyParser());

app.get('/', function(req, res){
	res.write('<html><body>\n');
	res.write('<h3>Welcome to the alpha test web service for the ' +
		'<a href="http://www.mediawiki.org/wiki/Parsoid">Parsoid project</a>.</h3>\n');
	res.write( '<p>Usage: <ul><li>GET /title for the DOM. ' +
		'Example: <strong><a href="/en/Main_Page">Main Page</a></strong></li>\n');
	res.write('<li>POST a DOM as parameter "content" to /title for the wikitext</li>\n');
	res.write('</ul>\n');
	res.write('<p>There are also some tools for experiments:\n<ul>\n');
	res.write('<li>Round-trip test pages from the English Wikipedia: ' +
		'<strong><a href="/_rt/en/Help:Magic">/_rt/Help:Magic</a></strong></li>\n');
	res.write('<li><strong><a href="/_rtform/">WikiText -&gt; HTML DOM -&gt; WikiText round-trip form</a></strong></li>\n');
	res.write('<li><strong><a href="/_wikitext/">WikiText -&gt; HTML DOM form</a></strong></li>\n');
	res.write('<li><strong><a href="/_html/">HTML DOM -&gt; WikiText form</a></strong></li>\n');
	res.write('</ul>\n');
	res.write('<p>We are currently focusing on round-tripping of basic formatting like inline/bold, headings, lists, tables and links. Templates, citations and thumbnails are not expected to round-trip properly yet. <strong>Please report issues you see at <a href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo&action=edit&section=new">:mw:Talk:Parsoid/Todo</a>. Thanks!</strong></p>\n');
	res.write('</body></html>');
});


var getParserServiceEnv = function ( res, iwp, pageName, cb ) {
	MWParserEnvironment.getParserEnv( parsoidConfig, null, iwp || '', pageName, function ( err, env ) {
		env.errCB = function ( e ) {
			var errmsg = e.stack || e.toString();
			var code = e.code || 500;
			console.log( errmsg );
			res.send( errmsg, code );
			// Force a clean restart of this worker
			process.exit(1);
		};
		if ( err === null ) {
			cb( env );
		} else {
			env.errCB( err );
		}
	} );
};


/**
 * robots.txt: no indexing.
 */
app.get(/^\/robots.txt$/, function ( req, res ) {
	res.end( "User-agent: *\nDisallow: /\n" );
});

/**
 * Redirects for old-style URL compatibility
 */
app.get( new RegExp( '^/((?:_rt|_rtve)/)?(' + getInterwikiRE() +
				'):(.*)$' ), function ( req, res ) {
	if ( req.params[0] ) {
		res.redirect(  '/' + req.params[0] + req.params[1] + '/' + req.params[2]);
	} else {
		res.redirect( '/' + req.params[1] + '/' + req.params[2]);
	}
	res.end( );
});

/**
 * Bug report posts
 */
app.post( /^\/_bugs\//, function ( req, res ) {
	console.log( '_bugs', req.body.data );
	try {
		var data = JSON.parse( req.body.data ),
			filename = '/mnt/bugs/' +
				new Date().toISOString() +
				'-' + encodeURIComponent(data.title);
		console.log( filename, data );
		fs.writeFile(filename, req.body.data, function(err) {
			if(err) {
				console.log(err);
			} else {
				console.log("The file " + filename + " was saved!");
			}
		});
	} catch ( e ) {
	}
	res.end( );
});


/**
 * Form-based HTML DOM -> wikitext interface for manual testing
 */
app.get(/\/_html\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your HTML DOM:" );
		textarea( res );
		res.end('');
	};

	getParserServiceEnv( res, null, req.params[0], cb );
} );

app.post(/\/_html\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		var doc = Util.parseHTML( '<html><body>' + req.body.content.replace(/\r/g, '') +
			'</body></html>' );
		res.write('<pre style="background-color: #efefef">');
		new Serializer({env: env}).serializeDOM(
			doc.body,
			function( c ) {
				res.write( htmlSpecialChars( c ) );
			},
			function() {
				res.write('</pre>');
				res.write( "<hr>Your HTML DOM:" );
				textarea( res, req.body.content.replace(/\r/g, '') );
				res.end('');
			}
			);
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
} );

/**
 * Form-based wikitext -> HTML DOM interface for manual testing
 */
app.get(/\/_wikitext\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your wikitext:" );
		textarea( res );
		res.end('');
	};

	getParserServiceEnv( res, null, req.params[0], cb );
} );

app.post(/\/_wikitext\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		var parser = Util.getParser(env, 'text/x-mediawiki/full'),
			src = req.body.content.replace(/\r/g, '');
		parser.on('document', function ( document ) {
			res.write(document.body.innerHTML);
			//res.write('<form method=POST><input name="content"></form>');
			//res.end("hello world\n" + req.method + ' ' + req.params.title);
			res.write( "<hr>Your wikitext:" );
			textarea( res, src );
			res.end('');
		});
		try {
			res.setHeader('Content-Type', 'text/html; charset=UTF-8');
			console.log('starting parsing of ' + req.params[0]);
			// FIXME: This does not handle includes or templates correctly
			env.page.src = src;
			parser.process( src );
		} catch (e) {
			console.log( e.stack || e.toString() );
			res.send( e.stack || e.toString(), 500 );
		}
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
} );

/**
 * Round-trip article testing
 */
app.get( new RegExp('/_rt/(' + getInterwikiRE() + ')/(.*)'), function(req, res) {
	var cb = function ( env ) {
		req.connection.setTimeout(300 * 1000);

		if ( env.page.name === 'favicon.ico' ) {
			res.send( 'no favicon yet..', 404 );
			return;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		console.log('starting parsing of ' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', parse.bind( tpr, env, req, res, roundTripDiff ));
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
} );

/**
 * Round-trip article testing with newline stripping for editor-created HTML
 * simulation
 */
app.get( new RegExp('/_rtve/(' + getInterwikiRE() + ')/(.*)') , function(req, res) {
	var cb = function ( env ) {
		if ( env.page.name === 'favicon.ico' ) {
			res.send( 'no favicon yet..', 404 );
			return;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		console.log('starting parsing of ' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid ),
			cb = function ( req, res, src, document ) {
				// strip newlines from the html
				var html = document.innerHTML.replace(/[\r\n]/g, ''),
					newDocument = Util.parseHTML(html);
				roundTripDiff( req, res, src, newDocument );
			};

		tpr.once('src', parse.bind( tpr, env, req, res, cb ));
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
});

/**
 * Form-based round-tripping for manual testing
 */
app.get(/\/_rtform\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your wikitext:" );
		textarea( res );
		res.end('');
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
});

app.post(/\/_rtform\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		// we don't care about \r, and normalize everything to \n
		parse( env, req, res, roundTripDiff, null, req.body.content.replace(/\r/g, ''));
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
} );

/**
 * Regular article parsing
 */
app.get(new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), function(req, res) {
	var cb = function ( env ) {
		if ( env.page.name === 'favicon.ico' ) {
			res.send( 'no favicon yet..', 404 );
			return;
		}
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		// Set the timeout to 900 seconds..
		req.connection.setTimeout(900 * 1000);

		var st = new Date();
		console.log('starting parsing of ' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		if ( req.query.cache ) {
			res.setHeader('Cache-Control', 's-maxage=2592000');
		}
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		// [CSA] allow cross-domain requests (CORS)
		res.setHeader('Access-Control-Allow-Origin', '*');

		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', parse.bind( null, env, req, res, function ( req, res, src, doc ) {
			res.end(Util.serializeNode(doc.documentElement));
			var et = new Date();
			console.warn("completed parsing of " + target + " in " + (et - st) + " ms");
		}));
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
} );

app.get( /\/_ci\/refs\/changes\/(\d+)\/(\d+)\/(\d+)/, function ( req, res ) {
	var gerritChange = 'refs/changes/' + req.params[0] + '/' + req.params[1] + '/' + req.params[2];
	var testSh = spawn( './testGerritChange.sh', [ gerritChange ], {
		cwd: '.'
	} );

	res.setHeader('Content-Type', 'text/xml; charset=UTF-8');

	testSh.stdout.on( 'data', function ( data ) {
		res.write( data );
	} );

	testSh.on( 'exit', function () {
		res.end( '' );
	} );
} );

app.get( /\/_ci\/master/, function ( req, res ) {
	var testSh = spawn( './testGerritMaster.sh', [], {
		cwd: '.'
	} );

	res.setHeader('Content-Type', 'text/xml; charset=UTF-8');

	testSh.stdout.on( 'data', function ( data ) {
		res.write( data );
	} );

	testSh.on( 'exit', function () {
		res.end( '' );
	} );
} );

/**
 * Regular article serialization using POST
 */
app.post( new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), function ( req, res ) {
	var cb = function ( env ) {
		var oldid = req.body.oldid || null;
		env.page.id = req.body.oldid || null;
		res.setHeader('Content-Type', 'text/x-mediawiki; charset=UTF-8');

		try {
			var doc = Util.parseHTML(req.body.content);
		} catch ( e ) {
			console.log( 'There was an error in the HTML5 parser! Sending it back to the editor.' );
			console.error( e.stack );
			res.send( e.stack, 500 );
		}

		env.errCB = function ( e ) {
			console.error( e.stack );
			res.send( e.stack, 500 );
		};

		try {
			// FIXME: Fetch oldid source and pass it in.
			new Serializer( { env: env, oldid: env.page.id } ).serializeDOM(
			// The below can be uncommented to turn on selective serialization on the main API service.
			// This is not currently advisable. It's not working perfectly.
			//new SelectiveSerializer( { env: env, oldid: oldid } ).serializeDOM(
				doc.body,
				function ( chunk ) {
					res.write( chunk );
				}, function () {
					// XXX TODO FIXME BBQ There should be an error callback in SelSer.
					res.end( '' );
				} );
		} catch ( e ) {
			env.errCB( e );
		}
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
} );

app.use( express.static( __dirname + '/scripts' ) );

console.log( ' - ' + instanceName + ' ready' );

module.exports = app;

