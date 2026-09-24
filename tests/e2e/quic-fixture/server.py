"""Loopback-only aioquic WebTransport fixture; all outputs go to the caller's temp dir."""
import asyncio
import datetime
import hashlib
import ipaddress
import json
import pathlib
import sys
from types import MethodType

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DatagramReceived, HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import HandshakeCompleted, ProtocolNegotiated
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def main_dir():
    if len(sys.argv) != 2:
        raise SystemExit('usage: server.py <absolute temporary output directory>')
    output = pathlib.Path(sys.argv[1]).resolve(strict=True)
    if not output.is_dir() or output == pathlib.Path(__file__).parent:
        raise SystemExit('fixture output must be an external directory')
    return output


OUTPUT = main_dir()
METRICS = OUTPUT / 'metrics.json'
CERT = OUTPUT / 'cert.pem'
KEY = OUTPUT / 'key.pem'
counts = {key: 0 for key in ('udp_packets', 'udp_bytes', 'quic_protocol_negotiated',
                             'quic_handshake_completed', 'h3_webtransport_connect',
                             'h3_webtransport_accepted', 'h3_datagrams')}


def emit():
    temporary = OUTPUT / 'metrics.tmp'
    temporary.write_text(json.dumps(counts, sort_keys=True), encoding='utf-8')
    temporary.replace(METRICS)


class FixtureProtocol(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.h3 = None

    def quic_event_received(self, event):
        if isinstance(event, ProtocolNegotiated):
            counts['quic_protocol_negotiated'] += 1
            if event.alpn_protocol in H3_ALPN:
                self.h3 = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(event, HandshakeCompleted):
            counts['quic_handshake_completed'] += 1
        if self.h3 is not None:
            for he in self.h3.handle_event(event):
                if isinstance(he, HeadersReceived):
                    headers = dict(he.headers)
                    if (headers.get(b':method') == b'CONNECT' and
                            headers.get(b':protocol') == b'webtransport' and
                            headers.get(b':path') == b'/fixture'):
                        counts['h3_webtransport_connect'] += 1
                        self.h3.send_headers(he.stream_id, [(b':status', b'200'),
                            (b'sec-webtransport-http3-draft', b'draft02')])
                        counts['h3_webtransport_accepted'] += 1
                    else:
                        self.h3.send_headers(he.stream_id, [(b':status', b'404')], end_stream=True)
                    self.transmit()
                elif isinstance(he, DatagramReceived):
                    counts['h3_datagrams'] += 1
                    self.h3.send_datagram(he.stream_id, b'ack')
                    self.transmit()
        emit()


async def run():
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')]))
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=2))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),
            x509.IPAddress(ipaddress.IPv4Address('127.0.0.1'))]), critical=False)
        .sign(key, hashes.SHA256()))
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    configuration = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN,
                                       max_datagram_frame_size=65536)
    configuration.load_cert_chain(str(CERT), str(KEY))
    emit()
    server = await serve('127.0.0.1', 0, configuration=configuration,
                         create_protocol=FixtureProtocol)
    original = server.datagram_received

    def counted(self, data, addr):
        counts['udp_packets'] += 1
        counts['udp_bytes'] += len(data)
        emit()
        return original(data, addr)

    server.datagram_received = MethodType(counted, server)
    port = server._transport.get_extra_info('sockname')[1]
    digest = hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()
    print(json.dumps({'ready': True, 'port': port, 'certificate_sha256_hex': digest}), flush=True)
    await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(run())
