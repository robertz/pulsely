package pulsely.socketbox;

import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.util.concurrent.CompletionStage;

/**
 * Plain (all-abstract) mirror of java.net.http.WebSocket.Listener's
 * callbacks. Every method on WebSocket.Listener itself is a Java `default`
 * method, which BoxLang's createDynamicProxy() cannot dispatch to a
 * proxied BoxLang component (ortus-boxlang/BoxLang#595) - it always runs
 * the JDK's own no-op default body instead. This interface has no default
 * methods, so a createDynamicProxy() built against it works correctly, and
 * PeerListenerAdapter (a real compiled WebSocket.Listener) forwards the
 * JDK's genuine callbacks to it.
 */
public interface PeerListenerCallback {
	void onOpen( WebSocket webSocket );

	CompletionStage<?> onText( WebSocket webSocket, CharSequence data, boolean last );

	CompletionStage<?> onBinary( WebSocket webSocket, ByteBuffer data, boolean last );

	CompletionStage<?> onClose( WebSocket webSocket, int statusCode, String reason );

	void onError( WebSocket webSocket, Throwable error );
}
