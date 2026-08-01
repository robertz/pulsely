package pulsely.socketbox;

import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.util.concurrent.CompletionStage;

/**
 * Real (compiled, non-proxied) java.net.http.WebSocket.Listener. Forwards
 * every JDK callback verbatim to a PeerListenerCallback - expected to be a
 * BoxLang createDynamicProxy() built against PeerListenerCallback, not
 * against WebSocket.Listener directly (see PeerListenerCallback's javadoc).
 * Does no flow-control bookkeeping of its own: callers of onOpen/onText/
 * onBinary are expected to call webSocket.request(1) themselves.
 */
public final class PeerListenerAdapter implements WebSocket.Listener {

	private final PeerListenerCallback callback;

	public PeerListenerAdapter( PeerListenerCallback callback ) {
		if ( callback == null ) {
			throw new IllegalArgumentException( "callback must not be null" );
		}
		this.callback = callback;
	}

	@Override
	public void onOpen( WebSocket webSocket ) {
		callback.onOpen( webSocket );
	}

	@Override
	public CompletionStage<?> onText( WebSocket webSocket, CharSequence data, boolean last ) {
		return callback.onText( webSocket, data, last );
	}

	@Override
	public CompletionStage<?> onBinary( WebSocket webSocket, ByteBuffer data, boolean last ) {
		return callback.onBinary( webSocket, data, last );
	}

	@Override
	public CompletionStage<?> onClose( WebSocket webSocket, int statusCode, String reason ) {
		return callback.onClose( webSocket, statusCode, reason );
	}

	@Override
	public void onError( WebSocket webSocket, Throwable error ) {
		callback.onError( webSocket, error );
	}
}
