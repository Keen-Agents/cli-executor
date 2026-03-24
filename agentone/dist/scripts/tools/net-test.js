// Network connectivity test — bare fetch, no timers

export async function exec() {
    const targets = [
        'https://httpbin.org/get',
        'https://jsonplaceholder.typicode.com/posts/1',
        'https://api.github.com',
        'https://b022-46-232-156-42.ngrok-free.app/api/health',
        'https://pc.tail7c837c.ts.net/api/health',
    ];

    const results = [];

    for (const url of targets) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'KeenTest/1.0' }
            });
            const body = await res.text().catch(() => '');
            results.push({
                url,
                status: res.status,
                ok: res.ok,
                bodyPreview: body.substring(0, 200)
            });
        } catch (err) {
            results.push({
                url,
                error: String(err.message || err),
            });
        }
    }

    dictionary.response = JSON.stringify({ results }, null, 2);
}
