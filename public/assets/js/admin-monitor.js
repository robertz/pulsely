/**
 * Polls the cross-tenant app/connection snapshot and refreshes the monitor in
 * place. Polling rather than push: each app's live connection count only makes
 * sense inside that app's own STOMP namespace (a connection authenticates as one
 * app key), so watching every app at once would mean one WebSocket per app
 * rather than the single feed the rest of the dashboard uses.
 */
( function () {
	'use strict';

	const config = document.getElementById( 'monitorConfig' );
	if ( !config ) return;

	const endpoint = config.dataset.endpoint;
	const intervalMs = Number( config.dataset.intervalMs || 4000 );

	const statusEl = document.getElementById( 'monitorStatus' );
	const statusText = statusEl ? statusEl.querySelector( '.live-text' ) : null;
	const tbody = document.querySelector( '#appsTable tbody' );

	const tiles = {
		accounts:    document.getElementById( 'tileAccounts' ),
		apps:        document.getElementById( 'tileApps' ),
		connections: document.getElementById( 'tileConnections' ),
		messages:    document.getElementById( 'tileMessages' )
	};

	// appId -> last-seen liveConnections, so a change can flash rather than just
	// silently redraw — the whole point of a monitor is to notice movement.
	let lastConnections = new Map();
	let timer = null;

	function setStatus( state, text ) {
		if ( !statusEl ) return;
		statusEl.dataset.state = state;
		if ( statusText ) statusText.textContent = text;
	}

	function flash( el ) {
		if ( !el ) return;
		el.classList.remove( 'flash' );
		void el.offsetWidth;
		el.classList.add( 'flash' );
	}

	function escapeHtml( s ) {
		return String( s ).replace( /[&<>"']/g, ( c ) => (
			{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ]
		) );
	}

	const fmt = ( n ) => Number( n || 0 ).toLocaleString();

	function renderRow( app ) {
		const limit = app.connectionLimit > 0
			? ` <span class="muted small"> / ${fmt( app.connectionLimit )}</span>`
			: '';
		const status = app.isActive
			? '<span class="pill pill-ok">active</span>'
			: '<span class="pill pill-off">paused</span>';

		const tr = document.createElement( 'tr' );
		tr.dataset.appId = app.appId;
		tr.innerHTML = `
			<td>
				${escapeHtml( app.name )}
				<div class="muted small"><code>${escapeHtml( app.appKey )}</code></div>
			</td>
			<td><a href="/admin/account/${encodeURIComponent( app.accountId )}">${escapeHtml( app.ownerEmail )}</a></td>
			<td>${escapeHtml( app.planName )}</td>
			<td><span class="tile-value-sm" data-field="liveConnections">${fmt( app.liveConnections )}</span>${limit}</td>
			<td data-field="peakToday">${fmt( app.peakToday )}</td>
			<td data-field="messagesToday">${fmt( app.messagesToday )}</td>
			<td data-field="status">${status}</td>`;
		return tr;
	}

	function render( data ) {
		if ( tiles.accounts ) tiles.accounts.textContent = fmt( data.totals.accountCount );
		if ( tiles.apps ) tiles.apps.textContent = fmt( data.totals.appCount );
		if ( tiles.messages ) tiles.messages.textContent = fmt( data.totals.messagesToday );
		if ( tiles.connections ) {
			const changed = tiles.connections.textContent.replace( /,/g, '' ) != String( data.totals.liveConnections );
			tiles.connections.textContent = fmt( data.totals.liveConnections );
			if ( changed ) flash( tiles.connections );
		}

		if ( !tbody ) return;

		// Sorted by live connections so the busiest apps stay at the top of an
		// otherwise-static list — the thing an admin scans for first.
		const apps = [ ...data.apps ].sort( ( a, b ) => b.liveConnections - a.liveConnections );
		const nextConnections = new Map();
		const frag = document.createDocumentFragment();

		for ( const app of apps ) {
			const row = renderRow( app );
			nextConnections.set( app.appId, app.liveConnections );
			if ( lastConnections.has( app.appId ) && lastConnections.get( app.appId ) !== app.liveConnections ) {
				flash( row.querySelector( '[data-field="liveConnections"]' ) );
			}
			frag.appendChild( row );
		}

		tbody.replaceChildren( frag );
		lastConnections = nextConnections;
	}

	async function poll() {
		try {
			const res = await fetch( endpoint, { headers: { Accept: 'application/json' } } );
			if ( !res.ok ) throw new Error( `HTTP ${res.status}` );
			render( await res.json() );
			setStatus( 'live', `Refreshing every ${Math.round( intervalMs / 1000 )}s` );
		} catch ( err ) {
			setStatus( 'error', `Refresh failed — ${err.message}. Retrying…` );
		}
	}

	timer = setInterval( poll, intervalMs );
	// Stop polling an admin console nobody is looking at.
	document.addEventListener( 'visibilitychange', () => {
		if ( document.hidden ) {
			clearInterval( timer );
		} else {
			poll();
			timer = setInterval( poll, intervalMs );
		}
	} );
} )();
