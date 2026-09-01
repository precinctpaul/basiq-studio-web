"""
Reads a local MP4/MOV file's top-level box structure (no dependencies) and
prints each box's name, byte offset, and size -- so we can see whether
'moov' comes before or after 'mdat'. If 'moov' is near the very end of the
file (offset close to file size), that's a non-"faststart" file: browsers
streaming it via HTTP range requests generally can't begin playback until
they've fetched at least that trailing 'moov' box, which for a large file
can mean the player looks permanently stuck even though every byte range
request is succeeding.

Usage:  python check_moov.py "C:\\path\\to\\cspan_662018.mp4"
"""
import sys
import struct

def walk_boxes(path):
    with open(path, "rb") as f:
        file_size = f.seek(0, 2)
        f.seek(0)
        offset = 0
        boxes = []
        while offset < file_size:
            f.seek(offset)
            header = f.read(8)
            if len(header) < 8:
                break
            size, box_type = struct.unpack(">I4s", header)
            box_type = box_type.decode("ascii", errors="replace")
            header_len = 8
            if size == 1:
                # 64-bit extended size follows
                ext = f.read(8)
                size = struct.unpack(">Q", ext)[0]
                header_len = 16
            elif size == 0:
                # box extends to EOF
                size = file_size - offset
            boxes.append((box_type, offset, size))
            if size < header_len:
                break  # malformed, stop rather than loop forever
            offset += size
    return file_size, boxes

if __name__ == "__main__":
    path = sys.argv[1]
    file_size, boxes = walk_boxes(path)
    print(f"File size: {file_size:,} bytes\n")
    print(f"{'box':6} {'offset':>15} {'size':>15} {'% into file':>12}")
    for box_type, offset, size in boxes:
        pct = 100 * offset / file_size if file_size else 0
        print(f"{box_type:6} {offset:>15,} {size:>15,} {pct:>11.1f}%")

    moov = next((b for b in boxes if b[0] == "moov"), None)
    mdat = next((b for b in boxes if b[0] == "mdat"), None)
    print()
    if moov and mdat:
        if moov[1] < mdat[1]:
            print("RESULT: moov comes BEFORE mdat -- this file IS faststart-friendly. Not the cause.")
        else:
            print("RESULT: moov comes AFTER mdat -- this file is NOT faststart. This is very likely why playback hangs.")
    else:
        print("RESULT: couldn't find both moov and mdat as top-level boxes -- send the box list above for a closer look.")
