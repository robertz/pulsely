/**
 * Drives the app dashboard's live tiles and activity feed.
 *
 * Uses the same public SDK customers use — the dashboard subscribes to the app's
 * reserved `$ops` channel with a short-lived token minted server-side.
 */
( function () {
	'use strict';

	const reveal = document.getElementById( 'revealSecret' );
	if ( reveal ) {
		reveal.addEventListener( 'click', () => {
			const el = document.getElementById( 'appSecret' );
			const hidden = el.textContent.startsWith( '•' );
			el.textContent = hidden ? el.dataset.secret : '••••••••••••••••';
			el.classList.toggle( 'secret', !hidden );
			reveal.textContent = hidden ? 'Hide' : 'Reveal';
		} );
	}

	const config = document.getElementById( 'opsConfig' );
	if ( !config ) return;

	const appKey = config.dataset.appKey;
	const opsToken = config.dataset.opsToken;
	const opsChannel = config.dataset.opsChannel;

	const statusEl = document.getElementById( 'liveStatus' );
	const statusText = statusEl ? statusEl.querySelector( '.live-text' ) : null;
	const tileMessages = document.getElementById( 'tileMessages' );
	const tileConnections = document.getElementById( 'tileConnections' );
	const feed = document.getElementById( 'feed' );
	const usageChart = document.getElementById( 'usageChart' );
	const usagePeakLabel = document.getElementById( 'usagePeakLabel' );

	function setStatus( state, text ) {
		if ( !statusEl ) return;
		statusEl.dataset.state = state;
		if ( statusText ) statusText.textContent = text;
	}

	function flash( el ) {
		if ( !el ) return;
		el.classList.remove( 'flash' );
		// Force reflow so the animation restarts on repeated updates.
		void el.offsetWidth;
		el.classList.add( 'flash' );
	}

	function addFeedItem( { time, channel, event } ) {
		if ( !feed ) return;
		const empty = document.getElementById( 'feedEmpty' );
		if ( empty ) empty.remove();

		const li = document.createElement( 'li' );
		li.className = 'feed-item is-new';
		li.innerHTML =
			'<span class="feed-time"></span>' +
			'<span class="feed-chan"></span>' +
			'<span class="feed-event"></span>';
		li.querySelector( '.feed-time' ).textContent = time;
		li.querySelector( '.feed-chan' ).textContent = channel;
		li.querySelector( '.feed-event' ).textContent = event;

		feed.prepend( li );
		while ( feed.children.length > 30 ) feed.lastElementChild.remove();
	}

	/**
	 * Bar heights are a percentage of the 14-day series max, so today's bar
	 * growing past every other day's count means every bar has to be
	 * rescaled, not just today's — otherwise today would clip past the top
	 * of the chart instead of the rest settling down under it.
	 */
	function updateUsageChart( messagesToday ) {
		if ( !usageChart ) return;
		const todayBar = document.getElementById( 'barToday' );
		if ( !todayBar ) return;

		todayBar.querySelector( '.bar' ).dataset.messages = messagesToday;
		todayBar.title = todayBar.title.replace( /: [\d,]+ messages$/, `: ${messagesToday.toLocaleString()} messages` );

		const bars = Array.from( usageChart.querySelectorAll( '.bar' ) );
		const max = Math.max( 1, ...bars.map( ( bar ) => Number( bar.dataset.messages || 0 ) ) );

		bars.forEach( ( bar ) => {
			const count = Number( bar.dataset.messages || 0 );
			bar.style.height = `${Math.max( 2, Math.round( count / max * 100 ) )}%`;
		} );

		usageChart.dataset.max = max;
		if ( usagePeakLabel ) usagePeakLabel.textContent = `Peak ${max.toLocaleString()} messages in a day.`;
		flash( todayBar.querySelector( '.bar' ) );
	}

	const bp = new Pulsely( appKey, { authToken: opsToken } );

	bp.bind( 'message.published', ( data ) => {
		if ( typeof data.messagesToday === 'number' ) {
			tileMessages.textContent = data.messagesToday.toLocaleString();
			flash( tileMessages );
			updateUsageChart( data.messagesToday );
		}
		addFeedItem( {
			time: data.at || new Date().toLocaleTimeString(),
			channel: data.channel || '',
			event: data.event || ''
		} );
	} );

	bp.bind( 'connections.changed', ( data ) => {
		tileConnections.textContent = Number( data.current || 0 ).toLocaleString();
		flash( tileConnections );
	} );

	// Event-driven rather than a one-shot .then()/.catch(): a dropped connection
	// auto-reconnects (STOMP.js's own retry), and without this the banner would
	// keep reading "Live" forever after the underlying socket actually died.
	bp.connection.bind( 'state_change', ( { current, error } ) => {
		if ( current === 'connecting' ) {
			setStatus( 'connecting', 'Connecting to live feed…' );
		} else if ( current === 'connected' ) {
			setStatus( 'live', 'Live' );
			// The dashboard's own socket is itself a connection, so the first count
			// only arrives once another client connects or disconnects. Seed it.
			if ( tileConnections.textContent === '—' ) tileConnections.textContent = '1';
		} else if ( current === 'unavailable' ) {
			setStatus( error ? 'error' : 'connecting', error ? `Live feed unavailable: ${error}` : 'Reconnecting…' );
		} else if ( current === 'disconnected' ) {
			setStatus( 'error', 'Live feed disconnected.' );
		}
	} );

	// A connect failure is already reflected by the state_change listener above;
	// this catch exists only so the rejection doesn't surface as an unhandled
	// promise rejection in the console.
	bp.connect().then( () => bp.subscribe( opsChannel ) ).catch( () => {} );

	window.addEventListener( 'beforeunload', () => bp.disconnect() );
} )();
