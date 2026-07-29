/**
 * Tabbed walkthrough on the marketing page.
 *
 * Progressive enhancement: the markup ships with every panel after the first
 * hidden, and this only takes over once it runs. Without JS a visitor still reads
 * step one rather than an empty box — see the noscript rule in marketing.css.
 */
( function () {
	'use strict';

	const root = document.getElementById( 'walkthrough' );
	if ( !root ) return;

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
} )();
