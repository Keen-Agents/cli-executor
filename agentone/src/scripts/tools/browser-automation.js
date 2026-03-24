function resolveBridge(dict) {
    return {
        url: dict.bridgeUrl || 'http://localhost:3222',
        token: dict.apiToken || ''
    };
}

async function bridgeCall(endpoint, body, config) {
  const response = await fetch(`${config.url}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-token': config.token,
      'Authorization': `Bearer ${config.token}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    let errMsg = response.statusText;
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(`Bridge error (${endpoint}): ${errMsg}`);
  }

  try { return JSON.parse(text); }
  catch { throw new Error(`Bridge returned non-JSON (${endpoint}): ${text.slice(0, 200)}`); }
}

export async function exec(dictionary) {
  const bridge = resolveBridge(dictionary);
  const mode = dictionary.mode || 'launch';
  const sessionId = dictionary.sessionId;
  const log = typeof dictionary.writeThinking === 'function'
    ? (msg) => dictionary.writeThinking(msg)
    : (msg) => console.log(`[browser-automation] ${msg}`);

  try {
    if (mode === 'health-check') {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${bridge.url}/api/health`, {
          method: 'GET',
          headers: { 'x-api-token': bridge.token },
          signal: controller.signal
        });
        clearTimeout(timer);
        dictionary.response = JSON.stringify({
          status: response.ok ? 'connected' : 'error',
          bridge: bridge.url
        });
      } catch (err) {
        dictionary.response = JSON.stringify({
          status: 'disconnected',
          bridge: bridge.url,
          message: 'Browser automation unavailable — no bridge connection.'
        });
      }
      return;
    }

    else if (mode === 'launch') {
      const result = await bridgeCall('/api/browser/launch', {
        headless: dictionary.headless !== false,
        viewport: dictionary.viewport || { width: 1280, height: 720 },
        timeout: dictionary.timeout || 30000,
        label: dictionary.label || 'agent-browser'
      }, bridge);
      dictionary.response = JSON.stringify(result);
      dictionary.browserSessionId = result.sessionId;
      log(`Browser launched: ${result.sessionId}`);
    }

    else if (mode === 'navigate') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      if (!dictionary.url) throw new Error("Missing 'url'");
      const result = await bridgeCall('/api/browser/navigate', {
        sessionId,
        url: dictionary.url,
        waitUntil: dictionary.waitUntil || 'load',
        timeout: dictionary.timeout || 30000
      }, bridge);
      dictionary.response = JSON.stringify(result);
      log(`Navigated to ${dictionary.url}`);
    }

    else if (mode === 'click') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      if (!dictionary.selector) throw new Error("Missing 'selector'");
      const result = await bridgeCall('/api/browser/click', {
        sessionId,
        selector: dictionary.selector,
        timeout: dictionary.timeout || 5000
      }, bridge);
      dictionary.response = JSON.stringify(result);
      log(`Clicked: ${dictionary.selector}`);
    }

    else if (mode === 'type') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      if (!dictionary.selector) throw new Error("Missing 'selector'");
      const result = await bridgeCall('/api/browser/type', {
        sessionId,
        selector: dictionary.selector,
        text: dictionary.text || '',
        delay: dictionary.delay || 50,
        clearFirst: dictionary.clearFirst || false,
        timeout: dictionary.timeout || 5000
      }, bridge);
      dictionary.response = JSON.stringify(result);
      log(`Typed into ${dictionary.selector}`);
    }

    else if (mode === 'screenshot') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      const result = await bridgeCall('/api/browser/screenshot', {
        sessionId,
        fullPage: dictionary.fullPage || false,
        selector: dictionary.selector || null,
        format: dictionary.format || 'png'
      }, bridge);
      dictionary.response = JSON.stringify({
        sessionId: result.sessionId,
        format: result.format,
        sizeKB: result.sizeKB,
        url: result.url,
        title: result.title
      });
      dictionary.screenshotBase64 = result.base64;
      log(`Screenshot taken: ${result.sizeKB}KB`);
    }

    else if (mode === 'content') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      const result = await bridgeCall('/api/browser/content', {
        sessionId,
        selector: dictionary.selector || null,
        mode: dictionary.contentMode || 'text',
        maxLength: dictionary.maxLength || 100000
      }, bridge);
      dictionary.response = result.content;
      log(`Content retrieved: ${result.length} chars`);
    }

    else if (mode === 'evaluate') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      if (!dictionary.expression) throw new Error("Missing 'expression'");
      const result = await bridgeCall('/api/browser/evaluate', {
        sessionId,
        expression: dictionary.expression
      }, bridge);
      dictionary.response = JSON.stringify(result.result);
      log('Evaluated JS expression');
    }

    else if (mode === 'close') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      const result = await bridgeCall('/api/browser/close', { sessionId }, bridge);
      dictionary.response = JSON.stringify(result);
      log(`Browser session closed: ${sessionId}`);
    }

    else {
      throw new Error(`Unknown mode: ${mode}. Use: launch, navigate, click, type, screenshot, content, evaluate, close`);
    }
  } catch (error) {
    const msg = error.message || '';
    const isConnectionError = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
        || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND');
    if (isConnectionError) {
      dictionary.response = JSON.stringify({
        error: 'BRIDGE_DISCONNECTED',
        message: `Bridge connection lost: ${msg}`,
        suggestion: 'Browser automation unavailable. Switch to cloud-only mode.'
      });
    } else {
      const errMsg = `Browser Automation Error: ${msg}`;
      log(errMsg);
      dictionary.response = errMsg;
    }
  }
}
