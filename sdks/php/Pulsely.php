<?php
/**
 * Pulsely server SDK for PHP — no dependencies beyond ext-curl and ext-json.
 *
 *   $bp = new Pulsely([
 *     'appId'     => getenv('PULSELY_APP_ID'),
 *     'appKey'    => getenv('PULSELY_APP_KEY'),
 *     'appSecret' => getenv('PULSELY_APP_SECRET'),
 *     'baseUrl'   => 'https://pulsely.example.com',
 *   ]);
 *
 *   $bp->trigger('orders', 'created', ['id' => 42]);
 *
 * The app secret must never reach a browser.
 */

class PulselyError extends \RuntimeException
{
    public $status;
    public $body;

    public function __construct($message, $status = 0, $body = null)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->body = $body;
    }
}

class Pulsely
{
    private $appId;
    private $appKey;
    private $appSecret;
    private $baseUrl;
    private $timeout;

    public function __construct(array $options)
    {
        if (empty($options['appId']) || empty($options['appSecret'])) {
            throw new PulselyError('Pulsely: appId and appSecret are required.');
        }
        $this->appId     = $options['appId'];
        $this->appKey    = $options['appKey'] ?? '';
        $this->appSecret = $options['appSecret'];
        $this->baseUrl   = rtrim($options['baseUrl'] ?? 'http://127.0.0.1:8085', '/');
        $this->timeout   = $options['timeout'] ?? 10;
    }

    /**
     * Publish an event to a channel.
     *
     * @throws PulselyError on any non-2xx.
     * @return mixed the decoded response body
     */
    public function trigger($channel, $event, $data = [])
    {
        // Serialize once and send exactly these bytes. Re-serializing for the
        // request risks a different key order and a signature that no longer
        // matches the body — the most common cause of a puzzling 401.
        $payload = json_encode([
            'channel' => $channel,
            'event'   => $event,
            'data'    => $data === [] ? new \stdClass() : $data,
        ]);

        $path      = '/apps/' . $this->appId . '/events';
        $timestamp = (string) time();   // epoch SECONDS, UTC

        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'X-Pulsely-Timestamp: ' . $timestamp,
                'X-Pulsely-Signature: ' . $this->sign('POST', $path, $timestamp, $payload),
            ],
        ]);

        $raw    = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error  = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new PulselyError('Pulsely: request failed — ' . $error);
        }

        $body = json_decode($raw, true);
        if ($body === null) {
            $body = $raw;
        }

        if ($status < 200 || $status > 299) {
            $detail = is_array($body) && isset($body['error']) ? $body['error'] : $raw;
            throw new PulselyError(
                "Pulsely: publish rejected ({$status}) — {$detail}", $status, $body
            );
        }

        return $body;
    }

    /**
     * Every currently occupied channel, as ['channel_name' => []] — or
     * ['user_count' => N] for a presence channel when info is 'user_count'.
     *
     * @throws PulselyError on any non-2xx.
     */
    public function listChannels($filterByPrefix = '', $info = '')
    {
        $path = '/apps/' . $this->appId . '/channels';
        $query = [];
        if ($filterByPrefix !== '') {
            $query['filter_by_prefix'] = $filterByPrefix;
        }
        if ($info !== '') {
            $query['info'] = $info;
        }
        $body = $this->get($path, $query);
        return is_array($body) && isset($body['channels']) ? $body['channels'] : [];
    }

    /**
     * Detail for one channel: ['occupied' => ..., 'subscription_count' => ...,
     * 'user_count' => ...?]. Returns rather than throwing for an unoccupied
     * channel — "not occupied" is a normal state, not a missing resource.
     *
     * @throws PulselyError on any non-2xx (e.g. an invalid channel name).
     */
    public function getChannel($channelName)
    {
        $path = '/apps/' . $this->appId . '/channels/' . $channelName;
        return $this->get($path, []);
    }

    /**
     * Signed GET request against the given (unsigned, no query string) path.
     * Query params are appended after signing — they are never part of the
     * signing string.
     */
    private function get($path, array $query)
    {
        $timestamp = (string) time();
        $signature = $this->sign('GET', $path, $timestamp, '');
        $url = $this->baseUrl . $path;
        if (!empty($query)) {
            $url .= '?' . http_build_query($query);
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_HTTPHEADER     => [
                'X-Pulsely-Timestamp: ' . $timestamp,
                'X-Pulsely-Signature: ' . $signature,
            ],
        ]);

        $raw    = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error  = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new PulselyError('Pulsely: request failed — ' . $error);
        }

        $body = json_decode($raw, true);
        if ($body === null) {
            $body = $raw;
        }

        if ($status < 200 || $status > 299) {
            $detail = is_array($body) && isset($body['error']) ? $body['error'] : $raw;
            throw new PulselyError(
                "Pulsely: request rejected ({$status}) — {$detail}", $status, $body
            );
        }

        return $body;
    }

    /**
     * Mint a short-lived connection token for a browser.
     *
     * The browser presents it as the STOMP passcode; it establishes the identity
     * your auth endpoint later sees as `user_token`. Public channels need none.
     */
    public function authToken($userId, $ttlSeconds = 3600)
    {
        if ($this->appKey === '') {
            throw new PulselyError('Pulsely: appKey is required to mint connection tokens.');
        }

        $expires   = time() + $ttlSeconds;
        $signature = hash_hmac('sha256', "{$this->appKey}:{$expires}:{$userId}", $this->appSecret);

        return "{$expires}.{$userId}.{$signature}";
    }

    /**
     * Build the response your auth endpoint returns when Pulsely asks whether a
     * subscriber may join a private or presence channel.
     *
     * Presence channels need userId; userInfo is echoed to every other member.
     */
    public function authorizeChannel($authorized = true, $userId = '', $userInfo = [])
    {
        return [
            'authorized' => (bool) $authorized,
            'user_id'    => (string) $userId,
            'user_info'  => $userInfo === [] ? new \stdClass() : $userInfo,
        ];
    }

    private function sign($method, $path, $timestamp, $payload)
    {
        $bodyHash = hash('sha256', $payload);
        // Joined by real newlines — double-quoted "\n" in PHP is a real newline,
        // so this is correct here, unlike in CFML/BoxLang.
        $signingString = strtoupper($method) . "\n{$path}\n{$timestamp}\n{$bodyHash}";

        return hash_hmac('sha256', $signingString, $this->appSecret);
    }
}
