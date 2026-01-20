import os
import re
import sys
import json
import pyfiglet
import argparse
import subprocess
import time
import threading
from rich.progress import Progress, TextColumn, BarColumn, TaskProgressColumn, SpinnerColumn
from typing import DefaultDict
from rich import print
from typing import DefaultDict

currentFile = __file__
realPath = os.path.realpath(currentFile)
dirPath = os.path.dirname(realPath)
dirName = os.path.basename(dirPath)

dvexe = dirPath + '/bin/dovi_tool.exe'
ffmpegexe = dirPath + '/bin/ffmpeg.exe'
mkvmergeexe = dirPath + '/bin/mkvmerge.exe'
mkvextractexe = dirPath + '/bin/mkvextract.exe'
mediainfoexe = dirPath + '/bin/MediaInfo.exe'
mp4boxexe = dirPath + '/bin/MP4Box.exe'
hdr10plusexe = dirPath + '/bin/hdr10plus_tool.exe'


def create_banner(text):
    return pyfiglet.figlet_format(text)

def _parse_digits(value):
    return int(re.sub(r"[^0-9]", "", str(value))) if value is not None else 0

def _parse_fps(track):
    num = track.get("FrameRate_Original_Num") or track.get("FrameRate_Num")
    den = track.get("FrameRate_Original_Den") or track.get("FrameRate_Den")
    if num and den:
        try:
            return float(num) / float(den)
        except (ValueError, ZeroDivisionError):
            pass
    fps_value = track.get("FrameRate_Original") or track.get("FrameRate")
    if fps_value:
        fps_str = re.sub(r"[^0-9./]", "", str(fps_value))
        if "/" in fps_str:
            num, den = fps_str.split("/", 1)
            try:
                return float(num) / float(den)
            except (ValueError, ZeroDivisionError):
                return 0.0
        try:
            return float(fps_str)
        except ValueError:
            return 0.0
    return 0.0

def get_mediainfo(file_path):
    result = subprocess.run(
        [mediainfoexe, "--Output=JSON", "-f", file_path],
        capture_output=True,
        text=True,
        encoding="utf-8"
    )
    info = json.loads(result.stdout or "{}")
    track = next((t for t in info.get("media", {}).get("track", []) if t.get("@type") == "Video"), None)
    if not track:
        return None
    return {
        "width": _parse_digits(track.get("Width")),
        "height": _parse_digits(track.get("Height")),
        "fps": _parse_fps(track),
        "track_id": _parse_digits(track.get("ID")),
        "format": str(track.get("Format", "")).lower()
    }

def delay_to_frames(delay_ms, fps):
    return round(abs(float(delay_ms)) * float(fps) / 1000)

def _is_hevc(path):
    return os.path.splitext(path)[1].lower() in [".hevc", ".h265"]

def _is_mp4(path):
    return os.path.splitext(path)[1].lower() in [".mp4", ".m4v", ".mov"]

def extract_hevc(input_path, output_path, track_id=0):
    if _is_hevc(input_path):
        return input_path, False
    if _is_mp4(input_path):
        subprocess.run([mp4boxexe, "-raw", str(track_id), "-out", output_path, input_path])
    else:
        subprocess.run(f'{mkvextractexe} {input_path} tracks 0:{output_path}', 
                      shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return output_path, True

def estimate_progress(file_path, output_file, task, progress, stage_name):
    """Monitor the size of an output file to estimate progress."""
    if not os.path.exists(output_file):
        time.sleep(1)
    
    try:
        input_size = os.path.getsize(file_path)
    except:
        input_size = 1000000000  # Fallback size if we can't get it

    while True:
        try:
            if os.path.exists(output_file):
                current_size = os.path.getsize(output_file)
                percent = min(95, int((current_size / input_size) * 100))
                progress.update(task, completed=percent, description=f"{stage_name} ({percent}%)")
        except:
            pass
            
        time.sleep(0.5)
        
        if not any(p.name == "progress_monitor" for p in threading.enumerate()):
            break

def do_dv_h(input_hdr, input_dv, out_put, keep_temp=False, delay_ms=0.0, hdr10plus_path=None, hdr10plus_delay_ms=0.0):
    mixfilenamename = os.path.basename(out_put)
    print(f" + Processing: {mixfilenamename}")
    audio_loc = f"{out_put}_audiosubs.mka"
    dv_hevc = f"{out_put}_dv.hevc"
    hdr10 = f"{out_put}_hdr10.hevc"
    dv_hdr = f"{out_put}_dv_hdr.hevc"
    rpu_bin = f"{out_put}_rpu.bin"
    temp_files = [audio_loc, dv_hdr, rpu_bin]

    hdr_info = get_mediainfo(input_hdr)
    dv_info = get_mediainfo(input_dv)
    if not hdr_info or not dv_info:
        print(" + Failed to read MediaInfo for input files.")
        return
    if abs(hdr_info["fps"] - dv_info["fps"]) > 0.001:
        print(f" + Frame Rate Mismatch - DV: {dv_info['fps']} | HDR: {hdr_info['fps']}")
        return

    crop = False
    crop_amount = 0
    if hdr_info["height"] != dv_info["height"]:
        if hdr_info["height"] < dv_info["height"]:
            crop_amount = (dv_info["height"] - hdr_info["height"]) // 2
            print(f" + Letterboxing needed - {crop_amount} | HDR: {hdr_info['height']} | DV: {dv_info['height']}")
        else:
            crop = True
            crop_amount = (hdr_info["height"] - dv_info["height"]) // 2
            print(f" + Cropping needed - {crop_amount} | HDR: {hdr_info['height']} | DV: {dv_info['height']}")

    delay_frames = 0
    remove_frames = ""
    duplicate_length = 0
    if delay_ms:
        delay_frames = delay_to_frames(delay_ms, hdr_info["fps"])
        print(f" + Dolby Vision Delay: {delay_frames} Frames")
    if delay_ms < 0 and delay_frames > 0:
        remove_frames = f"0-{abs(delay_frames) - 1}"
    elif delay_ms > 0:
        duplicate_length = delay_frames

    print(" + Step 1: Extracting Audios and Subtitles...")
    with Progress(SpinnerColumn(), BarColumn(), TaskProgressColumn()) as progress:
        task = progress.add_task("", total=100, completed=0)
        
        monitor_thread = threading.Thread(
            target=estimate_progress, 
            args=(input_hdr, audio_loc, task, progress, ""),
            name="progress_monitor"
        )
        monitor_thread.daemon = True
        monitor_thread.start()
        
        subprocess.run(f'{mkvmergeexe} -o {audio_loc} --no-video {input_hdr}', 
                      shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        progress.update(task, completed=100)
        monitor_thread.join(timeout=1)
    
    # Step 2: Extract DV video
    print(" + Step 2: Extracting DV H.265 Video...")
    with Progress(SpinnerColumn(), BarColumn(), TaskProgressColumn()) as progress:
        task = progress.add_task("", total=100, completed=0)

        if _is_hevc(input_dv):
            dv_hevc = input_dv
        else:
            monitor_thread = threading.Thread(
                target=estimate_progress, 
                args=(input_dv, dv_hevc, task, progress, ""),
                name="progress_monitor"
            )
            monitor_thread.daemon = True
            monitor_thread.start()
            dv_hevc, _ = extract_hevc(input_dv, dv_hevc, dv_info["track_id"])
            monitor_thread.join(timeout=1)
            temp_files.append(dv_hevc)

        progress.update(task, completed=100)
    
    # Step 3: Extract RPU (showing output)
    print(" + Step 3: Extracting RPU Data...")
    subprocess.run(f'{dvexe} -m 3 extract-rpu {dv_hevc} -o {rpu_bin}', shell=True)

    needs_rpu_edit = crop_amount > 0 or remove_frames or duplicate_length > 0
    if needs_rpu_edit:
        rpu_json = f"{out_put}_rpu.json"
        rpu_edited = f"{out_put}_rpu_edited.bin"
        json_data = {
            "active_area": {
                "crop": crop,
                "presets": [{
                    "id": 0,
                    "left": 0,
                    "right": 0,
                    "top": crop_amount,
                    "bottom": crop_amount
                }]},
            "remove": [
                remove_frames,
            ],
            "duplicate": [{
                "source": 0,
                "offset": 0,
                "length": duplicate_length
            }]}
        with open(rpu_json, "w+", encoding="utf-8") as outfile:
            outfile.write(json.dumps(json_data, indent=4))
        print(" + Editing RPU metadata...")
        subprocess.run([dvexe, "editor", "-i", rpu_bin, "-o", rpu_edited, "-j", rpu_json])
        temp_files.extend([rpu_json, rpu_edited])
        rpu_bin = rpu_edited
    
    # Step 4: Extract HDR10 video
    print(" + Step 4: Extracting HDR10 H.265 Video...")
    with Progress(SpinnerColumn(), BarColumn(), TaskProgressColumn()) as progress:
        task = progress.add_task("", total=100, completed=0)

        if _is_hevc(input_hdr):
            hdr10 = input_hdr
        else:
            monitor_thread = threading.Thread(
                target=estimate_progress, 
                args=(input_hdr, hdr10, task, progress, ""),
                name="progress_monitor"
            )
            monitor_thread.daemon = True
            monitor_thread.start()
            hdr10, _ = extract_hevc(input_hdr, hdr10, hdr_info["track_id"])
            monitor_thread.join(timeout=1)
            temp_files.append(hdr10)

        progress.update(task, completed=100)

    if hdr10plus_path:
        print(" + Step 4.5: Injecting HDR10+ Metadata...")
        hdr10plus_info = get_mediainfo(hdr10plus_path)
        if not hdr10plus_info:
            print(" + Failed to read HDR10+ MediaInfo.")
            return
        hdr10plus_hevc = f"{out_put}_hdr10plus.hevc"
        if _is_hevc(hdr10plus_path):
            hdr10plus_hevc = hdr10plus_path
        else:
            hdr10plus_hevc, _ = extract_hevc(hdr10plus_path, hdr10plus_hevc, hdr10plus_info["track_id"])
            temp_files.append(hdr10plus_hevc)
        hdr10plus_meta = f"{out_put}_hdr10plus.json"
        subprocess.run([hdr10plusexe, "extract", hdr10plus_hevc, "-o", hdr10plus_meta])
        temp_files.append(hdr10plus_meta)

        hdr10plus_meta_final = hdr10plus_meta
        if hdr10plus_delay_ms:
            hdr10plus_delay_frames = delay_to_frames(hdr10plus_delay_ms, hdr10plus_info["fps"])
            hdr10plus_remove = ""
            hdr10plus_duplicate = 0
            if hdr10plus_delay_ms < 0 and hdr10plus_delay_frames > 0:
                hdr10plus_remove = f"0-{abs(hdr10plus_delay_frames) - 1}"
            elif hdr10plus_delay_ms > 0:
                hdr10plus_duplicate = hdr10plus_delay_frames
            if hdr10plus_remove or hdr10plus_duplicate > 0:
                edits_json = f"{out_put}_hdr10plus_edits.json"
                hdr10plus_meta_final = f"{out_put}_hdr10plus_edited.json"
                edits_data = {
                    "remove": [hdr10plus_remove],
                    "duplicate": [{
                        "source": 0,
                        "offset": 0,
                        "length": hdr10plus_duplicate
                    }]
                }
                with open(edits_json, "w+", encoding="utf-8") as outfile:
                    outfile.write(json.dumps(edits_data, indent=4))
                subprocess.run([hdr10plusexe, "editor", hdr10plus_meta, "-j", edits_json, "-o", hdr10plus_meta_final])
                temp_files.extend([edits_json, hdr10plus_meta_final])

        hdr10plus_injected = f"{out_put}_hdr10plus_injected.hevc"
        subprocess.run([hdr10plusexe, "inject", "-i", hdr10, "-j", hdr10plus_meta_final, "-o", hdr10plus_injected])
        temp_files.append(hdr10plus_injected)
        hdr10 = hdr10plus_injected
    
    # Step 5: Inject RPU (showing output)
    print(" + Step 5: Injecting RPU Data to HDR10 H.265 Video...")
    subprocess.run(f'{dvexe} inject-rpu -i {hdr10} --rpu-in {rpu_bin} -o {dv_hdr}', shell=True)
    
    # Step 6: Merge final output
    print(" + Step 6: Muxing final output file...")
    with Progress(SpinnerColumn(), BarColumn(), TaskProgressColumn()) as progress:
        task = progress.add_task("", total=100, completed=0)
        
        monitor_thread = threading.Thread(
            target=estimate_progress, 
            args=(dv_hdr, out_put, task, progress, ""),
            name="progress_monitor"
        )
        monitor_thread.daemon = True
        monitor_thread.start()
        
        subprocess.run([mkvmergeexe, '--ui-language', 'en', '--no-date', '--output', out_put, dv_hdr, audio_loc], 
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        progress.update(task, completed=100)
        monitor_thread.join(timeout=1)
    
    print(f"+ ✅Completed Processing: {mixfilenamename}")
    
    if not keep_temp:
        print(" + Cleaning up temporary files...")
        for file in temp_files:
            if os.path.exists(file):
                os.remove(file)
        print(" + ✅Cleanup complete.")

if __name__ == '__main__':
    title = create_banner("HYBRID DV HDR Tool")
    description = "> By Ionicboy (Version 1.4)"
    print(title)
    print(description)
    print()

    arguments = argparse.ArgumentParser(description="Hybrid HDR10+ and Dolby Vision")
    arguments.add_argument("-o", '--output', dest="output", help="Specify output file name with no extension",
                           required=False)
    arguments.add_argument('--inputhdr', dest="inputhdrpath", help="Specify input HDR file name/folder", required=True)
    arguments.add_argument('--inputdv', dest="inputdvpath", help="Specify input DV file name/folder", required=True)
    arguments.add_argument('--keep', dest="keep", help="Keep the original file", action='store_true')
    arguments.add_argument('--delay', dest="delay", help="Dolby Vision delay in ms", type=float, default=0.0)
    arguments.add_argument('--hdr10plus', dest="hdr10plus", help="HDR10+ source file path", required=False)
    arguments.add_argument('--hdr10plus-delay', dest="hdr10plusdelay", help="HDR10+ delay in ms", type=float, default=0.0)
    args = arguments.parse_args()
    if os.path.isdir(args.inputhdrpath):
        hdr_files = os.listdir(args.inputhdrpath)
        dv_files = os.listdir(args.inputdvpath)
        for hdr_file in hdr_files:
            file_base_regex = re.compile(r'(.*)\.(HDR)+.*')
            file_base = file_base_regex.search(hdr_file).group(1)
            dv_file = [x for x in dv_files if re.compile(file_base).search(x)][0]
            output_file_name = file_base + ".DV.HDR.H.265-NOGRP.mkv"
            do_dv_h(
                args.inputhdrpath + '/' + hdr_file,
                args.inputdvpath + '/' + dv_file,
                "DV.HDR"+"/"+output_file_name,
                args.keep,
                args.delay,
                args.hdr10plus,
                args.hdr10plusdelay
            )
    else:
        do_dv_h(
            args.inputhdrpath,
            args.inputdvpath,
            args.output,
            args.keep,
            args.delay,
            args.hdr10plus,
            args.hdr10plusdelay
        )
