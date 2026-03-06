const BRIDGE_URL = process.env.AGENTONE_BRIDGE_URL || process.env.BRIDGE_URL || 'http://localhost:3222';
const API_TOKEN = process.env.AGENTONE_API_TOKEN || process.env.BRIDGE_API_TOKEN || '';

async function bridgeCall(endpoint, body) {
  const response = await fetch(`${BRIDGE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-token': API_TOKEN
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
  const mode = dictionary.mode || 'launch';
  const sessionId = dictionary.sessionId;
  const log = typeof dictionary.writeThinking === 'function'
    ? (msg) => dictionary.writeThinking(msg)
    : (msg) => console.log(`[browser-automation] ${msg}`);

  try {
    if (mode === 'launch') {
      const result = await bridgeCall('/api/browser/launch', {
        headless: dictionary.headless !== false,
        viewport: dictionary.viewport || { width: 1280, height: 720 },
        timeout: dictionary.timeout || 30000,
        label: dictionary.label || 'agent-browser'
      });
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
      });
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
      });
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
      });
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
      });
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
      });
      dictionary.response = result.content;
      log(`Content retrieved: ${result.length} chars`);
    }

    else if (mode === 'evaluate') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      if (!dictionary.expression) throw new Error("Missing 'expression'");
      const result = await bridgeCall('/api/browser/evaluate', {
        sessionId,
        expression: dictionary.expression
      });
      dictionary.response = JSON.stringify(result.result);
      log('Evaluated JS expression');
    }

    else if (mode === 'close') {
      if (!sessionId) throw new Error("Missing 'sessionId'");
      const result = await bridgeCall('/api/browser/close', { sessionId });
      dictionary.response = JSON.stringify(result);
      log(`Browser session closed: ${sessionId}`);
    }

    else {
      throw new Error(`Unknown mode: ${mode}. Use: launch, navigate, click, type, screenshot, content, evaluate, close`);
    }
  } catch (error) {
    const msg = `Browser Automation Error: ${error.message}`;
    log(msg);
    dictionary.response = msg;
  }
}
