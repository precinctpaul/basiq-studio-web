"""
Checks whether a file is raw MPEG Transport Stream data (.ts) saved under
a different extension (e.g. .mp4), rather than a real MP4/ISO-BMFF
container. Genuine MPEG-TS has a sync byte (0x47) at the start of every
188-byte packet, consistently, for as many packets as you check. A real
MP4 file will NOT show this pattern.

Usage:  python check_ts.py "C:\\path\\to\\file.mp4"
"""
import sys

PACKET_SIZE = 188
SYNC_BYTE = 0x47

def check(path, packets_to_check=200):
    with open(path, "rb") as f:
        data = f.read(PACKET_SIZE * packets_to_check)
    total = len(data) // PACKET_SIZE
    hits = sum(1 for i in range(total) if data[i * PACKET_SIZE] == SYNC_BYTE)
    return hits, total

if __name__ == "__main__":
    path = sys.argv[1]
    hits, total = check(path)
    pct = 100 * hits / total if total else 0
    print(f"Checked {total} consecutive 188-byte packets.")
    print(f"Sync byte (0x47) present at the start of {hits}/{total} ({pct:.1f}%).")
    print()
    if pct > 95:
        print("RESULT: this is raw MPEG-TS data, not a real MP4 container --")
        print("        it was very likely saved directly from an HLS/.m3u8 source")
        print("        without being remuxed into MP4.")
    elif pct > 20:
        print("RESULT: partial/ambiguous match -- inconclusive, worth a second look.")
    else:
        print("RESULT: does not look like MPEG-TS. Likely a genuine MP4 with some")
        print("        other issue (e.g. moov/mdat ordering).")
