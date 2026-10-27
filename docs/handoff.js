// handoff.js: lets another page (Strata) use this tool as a service, in a popup it opened itself.
// Nothing is uploaded anywhere: files move between the two windows with postMessage, in this browser.
//
// Protocol v1 (identical in ffmpeg.webcli.app; Strata's client is docs/editor/js/export/handoff.js):
//   tool   -> opener  { webcli: 1, type: 'ready', tool, version, ops, ...info }              sent on load and on every 'hello'; info is optional and additive
//   opener -> tool    { webcli: 1, type: 'hello' }
//   opener -> tool    { webcli: 1, type: 'job', id, op, args, files: { name: ArrayBuffer } }
//   opener -> tool    { webcli: 1, type: 'cancel', id }
//   tool   -> opener  { webcli: 1, type: 'progress', id, fraction, text }
//   tool   -> opener  { webcli: 1, type: 'result', id, files: { name: ArrayBuffer }, meta }
//   tool   -> opener  { webcli: 1, type: 'error', id, message }
//
// A job is aborted (as if cancelled) when the opener window is closed, since nobody is left to receive the result.
// Only a window this one was opened from (window.opener), at an allowed origin, is ever answered, and the answer goes to that origin only.

export const PROTOCOL = 1;
export const ALLOWED_ORIGINS = ['https://strataeditor.dev', 'https://www.strataeditor.dev'];

export function originAllowed( origin, allowed = ALLOWED_ORIGINS ) {

	return allowed.includes( origin ) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test( origin );

}

/**
 * Start serving jobs when this page was opened by another one; does nothing in a normal tab.
 * info: extra fields for the 'ready' message (additive; old clients ignore them). Must not hold secrets, 'ready' goes to any origin.
 * handlers: { [op]: async ( { args, files, progress( fraction, text ), signal } ) => ( { files: { name: Uint8Array | ArrayBuffer }, meta } ) }
 * Returns null in a normal tab, otherwise { opener, busy() }.
 */
export function serve( { tool, version, handlers, info = {}, allowed = ALLOWED_ORIGINS, onJob = null, onIdle = null, watchMs = 1000 } ) {

	if ( ! window.opener || window.opener === window ) return null;
	const opener = window.opener;
	const ops = Object.keys( handlers );
	let running = null;

	const post = ( origin, msg, transfer = [] ) => { try { opener.postMessage( { webcli: PROTOCOL, ...msg }, origin, transfer ); } catch ( e ) { /* opener gone */ } };
	const hello = () => post( '*', { ...info, type: 'ready', tool, version, ops } );   // no secrets in it; jobs are only answered to an allowed origin

	window.addEventListener( 'message', async ( e ) => {

		if ( e.source !== opener || ! originAllowed( e.origin, allowed ) ) return;
		const m = e.data;
		if ( ! m || m.webcli !== PROTOCOL ) return;
		if ( m.type === 'hello' ) return hello();
		if ( m.type === 'cancel' ) { if ( running && running.id === m.id ) running.abort.abort(); return; }
		if ( m.type !== 'job' ) return;

		const reply = ( msg, transfer ) => post( e.origin, { id: m.id, ...msg }, transfer );
		if ( running ) return reply( { type: 'error', message: 'This tool is already running another job.' } );
		const handler = handlers[ m.op ];
		if ( ! handler ) return reply( { type: 'error', message: `Unknown op '${ m.op }'. This tool does: ${ ops.join( ', ' ) }.` } );

		running = { id: m.id, abort: new AbortController() };
		const watch = setInterval( () => { if ( opener.closed ) running.abort.abort(); }, watchMs );
		try {

			if ( onJob ) onJob( m );
			const out = await handler( {
				args: m.args || {}, files: m.files || {}, signal: running.abort.signal,
				progress: ( fraction, text ) => reply( { type: 'progress', fraction, text } ),
			} );
			const files = {};
			const transfer = [];
			for ( const [ name, data ] of Object.entries( out.files || {} ) ) {

				const buf = data instanceof ArrayBuffer ? data : data.buffer.slice( data.byteOffset, data.byteOffset + data.byteLength );
				files[ name ] = buf;
				transfer.push( buf );

			}
			reply( { type: 'result', files, meta: out.meta || {} }, transfer );

		} catch ( err ) {

			reply( { type: 'error', message: err && err.message ? err.message : String( err ) } );

		} finally {

			clearInterval( watch );
			running = null;
			if ( onIdle ) onIdle();

		}

	} );

	hello();
	return { opener, busy: () => !! running };

}
