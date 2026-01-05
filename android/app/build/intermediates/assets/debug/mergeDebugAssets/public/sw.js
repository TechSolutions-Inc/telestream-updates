/* eslint-disable no-restricted-globals */
// Pull-based streaming service worker supporting Range Requests

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Map of requestId -> Resolver function
const pendingRequests = new Map();

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'DATA_RESPONSE') {
        const resolver = pendingRequests.get(data.requestId);
        if (resolver) {
            resolver(data.chunk); // chunk is ArrayBuffer
            pendingRequests.delete(data.requestId);
        }
    } else if (data.type === 'DATA_ERROR') {
        const resolver = pendingRequests.get(data.requestId);
        if (resolver) {
            resolver(null); // Resolve null to indicate error
            pendingRequests.delete(data.requestId);
        }
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (url.pathname.includes('/virtual-stream/')) {
        // Format: /virtual-stream/{fileId}/{fileSize}
        // We need fileSize to handle Range requests correctly 206
        const parts = url.pathname.split('/');
        const sizeStr = parts.pop();
        const fileId = parts.pop(); // Not strictly needed here given we talk to active client, but good context
        const fileSize = parseInt(sizeStr, 10);

        event.respondWith(handleRangeRequest(event.request, fileId, fileSize));
    }
});

async function handleRangeRequest(request, fileId, fileSize) {
    const rangeHeader = request.headers.get('Range');
    let start = 0;
    let end = fileSize - 1;

    if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const partialStart = parts[0];
        const partialEnd = parts[1];

        start = parseInt(partialStart, 10);
        end = partialEnd ? parseInt(partialEnd, 10) : end;
    }

    // Chunk size limit for sanity
    if (end - start > 1024 * 1024) {
        end = start + 1024 * 1024 - 1;
    }

    // Ask client for data
    const chunk = await requestDataFromClient(fileId, start, end);

    if (!chunk) {
        return new Response("Error fetching data", { status: 500 });
    }

    const headers = new Headers();
    headers.set("Content-Type", "video/mp4");
    headers.set("Content-Length", chunk.byteLength);
    headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    headers.set("Accept-Ranges", "bytes");

    return new Response(chunk, {
        status: 206,
        headers: headers
    });
}

async function requestDataFromClient(fileId, start, end) {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (!clients || clients.length === 0) return null;

    // We assume the controlling client is the one to ask. 
    // In a sophisticated app we might check which client initiated the stream.
    // For now, ask the first active one.
    const client = clients[0];

    return new Promise((resolve) => {
        const requestId = Math.random().toString(36).substring(7);
        pendingRequests.set(requestId, resolve);

        // Timeout safety
        setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                resolve(null);
            }
        }, 15000); // 15s timeout

        client.postMessage({
            type: 'REQUEST_DATA',
            requestId: requestId,
            start: start,
            end: end,
            fileId: fileId // Echo back context
        });
    });
}
