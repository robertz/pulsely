/**
 * Live Orders demo — browser side.
 *
 * Deliberately uses only the public app key. Every publish is a request to this
 * demo's own server, which signs it; the browser never holds the app secret and
 * a STOMP SEND from here would be rejected by the broker anyway.
 *
 * The public feed and the private-channel test still get their own connection,
 * mainly so the two panels can be reasoned about independently and re-joining
 * the private channel never disturbs the public one. It's no longer a safety
 * requirement: a refused private-channel subscribe is a `subscription_error`
 * MESSAGE on a connection that stays open, not a connection-fatal STOMP ERROR.
 *
 * Status is driven by `bp.connection.bind('state_change', ...)` for transport
 * connectivity and `bp.bind('subscription_succeeded' | 'subscription_error', ...)`
 * for whether a specific channel was actually granted — never by reaching into
 * `bp.client` directly, which is what caused this page to go silently stale
 * after a refusal in an earlier version of this demo.
 */
( () => {
	'use strict';

	const $ = ( id ) => document.getElementById( id );

	const els = {
		conn: $( 'conn' ), connLabel: $( 'conn-label' ),
		privConn: $( 'privConn' ), privConnLabel: $( 'priv-conn-label' ),
		feed: $( 'feed' ), feedEmpty: $( 'feed-empty' ),
		opsFeed: $( 'ops-feed' ), log: $( 'log' ),
		publish: $( 'publish' ), burst: $( 'burst' ),
		join: $( 'join' ), joinAnon: $( 'join-anon' ),
		who: $( 'who' ), note: $( 'note' ), sendNote: $( 'send-note' ),
		clearLog: $( 'clear-log' ),
		publicName: $( 'public-name' ), privateName: $( 'private-name' )
	};

	let cfg = null;
	let bpPublic = null;
	let bpPrivate = null;

	/* ----------------------------------------------------------------- log */

	function log( message, kind = '' ) {
		const li = document.createElement( 'li' );
		if ( kind ) li.className = kind;
		const t = new Date().toLocaleTimeString( [], { hour12: false } );
		li.innerHTML = `<span class="t">${t}</span> ${escapeHtml( message )}`;
		els.log.prepend( li );
		while ( els.log.children.length > 80 ) els.log.lastChild.remove();
	}

	function escapeHtml( s ) {
		return String( s ).replace( /[&<>"']/g, ( c ) => (
			{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ]
		) );
	}

	function setStatus( pillEls, state, label ) {
		pillEls.pill.dataset.state = state;
		pillEls.label.textContent = label;
	}

	/* --------------------------------------------------------------- feeds */

	const money = ( cents ) => '$' + ( cents / 100 ).toFixed( 2 );

	function addOrder( order, meta ) {
		els.feedEmpty.hidden = true;
		const li = document.createElement( 'li' );
		if ( meta.replayed ) li.classList.add( 'is-replay' );
		li.innerHTML = `
			<span class="id">#${escapeHtml( order.id )}</span>
			<span class="item">${escapeHtml( order.item )}</span>
			<span class="total">${escapeHtml( money( order.total ) )}</span>
			<span class="meta">${escapeHtml( order.city )}${meta.replayed ? ' · replay' : ''}</span>`;
		els.feed.prepend( li );
		while ( els.feed.children.length > 60 ) els.feed.lastChild.remove();
	}

	function addNote( note, meta ) {
		const li = document.createElement( 'li' );
		if ( meta.replayed ) li.classList.add( 'is-replay' );
		li.innerHTML = `
			<span class="item">${escapeHtml( note.text )}</span>
			<span class="meta">${meta.replayed ? 'replay' : 'live'}</span>`;
		els.opsFeed.prepend( li );
		while ( els.opsFeed.children.length > 40 ) els.opsFeed.lastChild.remove();
	}

	/* ----------------------------------------------------------------- api */

	async function api( path, body ) {
		const res = await fetch( path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( body || {} )
		} );
		const json = await res.json().catch( () => ( {} ) );
		if ( !res.ok ) throw new Error( json.error || `HTTP ${res.status}` );
		return json;
	}

	/* --------------------------------------------------------------- start */

	async function start() {
		cfg = await ( await fetch( '/api/config' ) ).json();
		els.publicName.textContent = cfg.publicChannel;
		els.privateName.textContent = cfg.privateChannel;

		bpPublic = new Pulsely( cfg.appKey, { url: cfg.wsUrl } );

		bpPublic.bind( 'created', ( data, meta ) => {
			addOrder( data, meta );
			log( `${meta.channel} → created #${data.id}${meta.replayed ? ' (replay)' : ''}` );
		} );

		const publicEls = { pill: els.conn, label: els.connLabel };
		bpPublic.connection.bind( 'state_change', ( { current, error } ) => {
			if ( current === 'connected' ) setStatus( publicEls, 'live', 'live' );
			else if ( current === 'unavailable' ) setStatus( publicEls, 'down', error || 'reconnecting…' );
			else if ( current === 'disconnected' ) setStatus( publicEls, 'down', 'disconnected' );
		} );

		try {
			await bpPublic.connect();
		} catch ( err ) {
			log( `connect refused — ${err.message}`, 'err' );
			return;
		}

		log( `connected as app key ${cfg.appKey}`, 'ok' );
		bpPublic.subscribe( cfg.publicChannel );
		log( `subscribed to ${cfg.publicChannel}`, 'ok' );

		wireButtons();
	}

	function wireButtons() {

		els.publish.addEventListener( 'click', async () => {
			els.publish.disabled = true;
			try {
				const r = await api( '/api/publish', { channel: cfg.publicChannel } );
				log( `published order #${r.data.id}`, 'ok' );
			} catch ( err ) {
				log( `publish failed — ${err.message}`, 'err' );
			} finally {
				els.publish.disabled = false;
			}
		} );

		els.burst.addEventListener( 'click', async () => {
			els.burst.disabled = true;
			for ( let i = 0; i < 5; i++ ) {
				try {
					await api( '/api/publish', { channel: cfg.publicChannel } );
				} catch ( err ) {
					log( `publish failed — ${err.message}`, 'err' );
					break;
				}
				await new Promise( ( r ) => setTimeout( r, 220 ) );
			}
			els.burst.disabled = false;
		} );

		els.join.addEventListener( 'click', () => joinPrivate( true ) );
		els.joinAnon.addEventListener( 'click', () => joinPrivate( false ) );

		els.sendNote.addEventListener( 'click', sendNote );
		els.note.addEventListener( 'keydown', ( e ) => { if ( e.key === 'Enter' ) sendNote(); } );

		els.clearLog.addEventListener( 'click', () => { els.log.innerHTML = ''; } );
	}

	/**
	 * Its own connection every time it's called, so clicking "Join with token"
	 * after "Join anonymously" refused — or just retrying — always starts clean
	 * rather than requiring a page reload.
	 *
	 * A refused private-channel subscribe is a `subscription_error` MESSAGE on a
	 * connection that stays open — not a STOMP ERROR that kills it — so there is
	 * no retry storm to stop and no heuristic needed to tell "joined" from
	 * "about to be refused": subscription_succeeded / subscription_error are
	 * real, deterministic confirmations from the broker.
	 */
	async function joinPrivate( withToken ) {
		const privEls = { pill: els.privConn, label: els.privConnLabel };

		if ( bpPrivate ) {
			bpPrivate.disconnect();
		}
		els.sendNote.disabled = true;

		let token = '';
		if ( withToken ) {
			const userId = els.who.value.trim() || 'ops-1';
			try {
				( { token } = await api( '/api/token', { userId } ) );
				log( `minted connection token for ${userId}`, 'ok' );
			} catch ( err ) {
				log( `token mint failed — ${err.message}`, 'err' );
				return;
			}
		} else {
			log( 'joining with no token — expect the auth endpoint to refuse', 'info' );
		}

		setStatus( privEls, 'idle', 'connecting…' );

		const bp = new Pulsely( cfg.appKey, { url: cfg.wsUrl, authToken: token } );
		bpPrivate = bp;
		bp.bind( 'note', ( d, m ) => { addNote( d, m ); log( `${m.channel} → note`, 'info' ); } );

		// A superseded connection (the user clicked Join again) keeps running in
		// the background until its disconnect() call above takes effect — guard
		// every handler so its events can't clobber a newer attempt's status.
		const isCurrent = () => bpPrivate === bp;

		bp.connection.bind( 'state_change', ( { current, error } ) => {
			if ( !isCurrent() ) return;
			if ( current === 'unavailable' ) {
				els.sendNote.disabled = true;
				setStatus( privEls, 'down', error || 'reconnecting…' );
			} else if ( current === 'disconnected' ) {
				els.sendNote.disabled = true;
				setStatus( privEls, 'down', 'disconnected' );
			}
		} );

		bp.bind( 'subscription_succeeded', ( data, meta ) => {
			if ( !isCurrent() || meta.channel !== cfg.privateChannel ) return;
			setStatus( privEls, 'live', 'connected' );
			els.sendNote.disabled = false;
			log( `joined ${cfg.privateChannel}`, 'ok' );
		} );

		bp.bind( 'subscription_error', ( data, meta ) => {
			if ( !isCurrent() || meta.channel !== cfg.privateChannel ) return;
			setStatus( privEls, 'down', 'refused' );
			els.sendNote.disabled = true;
			log( `subscribe refused — ${data.reason}`, 'err' );
		} );

		try {
			await bp.connect();
		} catch ( err ) {
			setStatus( privEls, 'down', 'refused' );
			log( `connect refused — ${err.message}`, 'err' );
			return;
		}

		setStatus( privEls, 'idle', 'confirming subscribe…' );
		bp.subscribe( cfg.privateChannel );
		log( `subscribe requested for ${cfg.privateChannel} — auth endpoint deciding…`, 'info' );
	}

	async function sendNote() {
		const text = els.note.value.trim();
		if ( !text ) return;
		try {
			await api( '/api/publish', { channel: cfg.privateChannel, text } );
			els.note.value = '';
			log( 'note published', 'ok' );
		} catch ( err ) {
			log( `note failed — ${err.message}`, 'err' );
		}
	}

	start().catch( ( err ) => {
		log( `startup failed — ${err.message}`, 'err' );
	} );

} )();
