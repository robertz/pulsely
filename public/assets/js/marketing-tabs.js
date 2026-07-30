/**
 * Tabbed content on the marketing page and docs page — the "How it works"
 * walkthrough, and every per-language code example on /docs.
 *
 * Progressive enhancement: each group's markup ships with every panel after
 * the first hidden, and this only takes over once it runs. Without JS a
 * visitor still reads every panel stacked rather than an empty box — see the
 * `.no-js` rules in marketing.css.
 *
 * Multiple independent tab groups can exist on one page (one per docs code
 * example), each initialized separately so switching one never affects
 * another.
 */
( function () {
	'use strict';

	// The original walkthrough kept its id for backward compatibility; every
	// other group opts in with data-tabgroup.
	const roots = [
		document.getElementById( 'walkthrough' ),
		...document.querySelectorAll( '[data-tabgroup]' )
	].filter( Boolean );

	roots.forEach( initTabGroup );

	function initTabGroup( root ) {
		const tabs = Array.from( root.querySelectorAll( '[role="tab"]' ) );
		const panels = tabs.map( ( tab ) => document.getElementById( tab.getAttribute( 'aria-controls' ) ) );
		if ( !tabs.length ) return;

		// Only reachable tab stops are the selected tab, per the tabs pattern —
		// arrow keys move between them.
		function select( index, { focus = false } = {} ) {
			tabs.forEach( ( tab, i ) => {
				const active = i === index;
				tab.setAttribute( 'aria-selected', active ? 'true' : 'false' );
				tab.tabIndex = active ? 0 : -1;
				if ( panels[ i ] ) panels[ i ].hidden = !active;
			} );
			if ( focus ) tabs[ index ].focus();

			// On narrow screens the tablist scrolls; keep the active tab in view.
			// `block: 'nearest'` so this never yanks the page vertically.
			const list = tabs[ index ].parentElement;
			if ( list && list.scrollWidth > list.clientWidth ) {
				tabs[ index ].scrollIntoView( { inline: 'nearest', block: 'nearest', behavior: 'smooth' } );
			}
		}

		tabs.forEach( ( tab, i ) => {
			tab.addEventListener( 'click', () => select( i ) );

			tab.addEventListener( 'keydown', ( ev ) => {
				let next = null;
				if ( ev.key === 'ArrowRight' ) next = ( i + 1 ) % tabs.length;
				else if ( ev.key === 'ArrowLeft' ) next = ( i - 1 + tabs.length ) % tabs.length;
				else if ( ev.key === 'Home' ) next = 0;
				else if ( ev.key === 'End' ) next = tabs.length - 1;

				if ( next !== null ) {
					ev.preventDefault();
					select( next, { focus: true } );
				}
			} );
		} );

		select( 0 );
	}
} )();
