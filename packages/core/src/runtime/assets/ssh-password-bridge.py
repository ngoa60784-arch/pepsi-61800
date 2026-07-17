"""Cross-platform password SSH bridge for the Bun host.

The password is accepted only through TCH_SSH_PASSWORD, never argv.
stdin/stdout/stderr remain byte streams so provisioning scripts can be piped safely.
"""

import argparse
import asyncio
import os
import sys

import asyncssh


async def _copy_stream(reader, writer) -> None:
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            return
        writer.write(chunk)
        writer.flush()


async def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--username", required=True)
    parser.add_argument("--command", required=True)
    args = parser.parse_args()

    password = os.environ.get("TCH_SSH_PASSWORD", "")
    if not password:
        raise RuntimeError("TCH_SSH_PASSWORD is required")

    async with asyncssh.connect(
        args.host,
        port=args.port,
        username=args.username,
        password=password,
        known_hosts=None,
        connect_timeout=20,
    ) as connection:
        process = await connection.create_process(args.command, encoding=None)
        stdin_data = await asyncio.to_thread(sys.stdin.buffer.read)
        if stdin_data:
            process.stdin.write(stdin_data)
        process.stdin.write_eof()
        await asyncio.gather(
            _copy_stream(process.stdout, sys.stdout.buffer),
            _copy_stream(process.stderr, sys.stderr.buffer),
        )
        await process.wait()
        return process.exit_status if process.exit_status is not None else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_main()))
    except (asyncssh.Error, OSError, RuntimeError) as error:
        print(f"SSH bridge error: {error}", file=sys.stderr)
        raise SystemExit(255)
