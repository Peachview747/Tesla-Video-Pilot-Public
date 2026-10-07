#!/usr/bin/env python3
"""
Tiny TCP relay: exposes the app on the Mac's hotspot IP.

Colima forwards container ports to 127.0.0.1 only, so other devices on the
hotspot (the Tesla) can't reach it. This listens on the hotspot IP and pipes
each connection through to 127.0.0.1 on the same port.

    python3 relay.py <listen-ip> <port>
"""
import asyncio
import sys

LISTEN_HOST = sys.argv[1]
PORT = int(sys.argv[2])


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(client_reader, client_writer):
    try:
        up_reader, up_writer = await asyncio.open_connection("127.0.0.1", PORT)
    except Exception:
        client_writer.close()
        return
    await asyncio.gather(
        pipe(client_reader, up_writer),
        pipe(up_reader, client_writer),
    )


async def main():
    server = await asyncio.start_server(handle, LISTEN_HOST, PORT)
    async with server:
        await server.serve_forever()


asyncio.run(main())
