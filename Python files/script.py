import argparse
import subprocess,os,json,shutil
from types import SimpleNamespace

DV_TOOL = 'dovi_tool'
HDR_TOOL = 'hdr10plus_tool'
MKV_MERGE = 'mkvmerge'
MINFO = 'MediaInfo.exe' 
MP4BOX_PATH = 'MP4Box'
dovi_tool_profile = 3 #Refer to this for further info https://github.com/quietvoid/dovi_tool#conversion-modes
GREEN = '\033[92m'
RED = '\033[91m'
RESET = '\033[0m'

def json_to_namespace(obj):
    if isinstance(obj, dict):
        return SimpleNamespace(**{
            k.lower().strip("@"): json_to_namespace(v) for k, v in obj.items()
        })
    elif isinstance(obj, list):
        return [json_to_namespace(i) for i in obj]
    return obj

def get_mediainfo(file_path):
    result = subprocess.run(
        [MINFO, "--Output=JSON", '-f',file_path],
        capture_output=True,
        text=True,
        encoding="utf-8"
    )
    return json_to_namespace(json.loads(result.stdout))

def get_vid_info(info):
    return next((track for track in info.media.track if track.type == "Video"), None)

def get_fps(info):
    if hasattr(info,'framerate_original_num'): 
        return int(info.framerate_original_num) / int(info.framerate_original_den)
    return int(info.framerate_num) / int(info.framerate_den)      
        
def demux_file(file_path,index,output_path):
    subprocess.run([MP4BOX_PATH,'-raw',str(index),'-out',output_path,file_path]) 
    if not os.path.exists(output_path):
        print(f'Failed To Demux {output_path}')
        return True

def uniquify(path):
    filename, extension = os.path.splitext(path)
    counter = 1
    while os.path.exists(path):
        path = filename + "." + str(counter) + extension
        counter += 1
    return path

def delay_to_frames(delay_ms: float, fps: float) -> int:
    return round(abs(float(delay_ms)) * float(fps) / 1000)

def rvf(file_path):
    try:os.remove(file_path)
    except:pass

def DOVI_OPERATIONS(dv_file,hdr_file,delay,main_folder):
    DI = get_mediainfo(dv_file)
    DVI = get_vid_info(DI)
    HI = get_mediainfo(hdr_file)
    HVI = get_vid_info(HI)

    if not HVI:
        print(f'No Video Streams Found in {hdr_file}')
        return
    
    if not DVI:
        print(f'No Video Streams Found in {hdr_file}')
        return
    
    if HVI.framerate != DVI.framerate:
        print(f'Frame Rate Mismatch - DV : {DVI.framerate} | HDR : {HVI.framerate}')
        return
    
    if DI.media.track[0].format.lower() == "hevc":
        dv_raw = dv_file
    else:
        dv_raw = os.path.join(main_folder,'dv.hevc')
        print('\n\nDemuxing Dovi File')
        is_failed = demux_file(dv_file,DVI.id,dv_raw)
        if is_failed: 
            return

    print('\n\nExtracting RPU')
    RPU_PATH = os.path.join(main_folder,'rpu.bin')
    subprocess.run([DV_TOOL,'-m',str(dovi_tool_profile),'extract-rpu',dv_raw,'-o',RPU_PATH])  

    if not DI.media.track[0].format.lower() == "hevc":
        os.remove(dv_raw)

    if not os.path.exists(RPU_PATH) or os.path.getsize(RPU_PATH) == 0:
        print('Failed To Extract RPU')
        return 
    
    crop = False
    crop_amount = 0
    frame_rate = get_fps(HVI)
    delay_frames = 0
    remove_frames = ""

    dv_h = int(DVI.height)
    hdr_h = int(HVI.height)

    if dv_h != hdr_h:
        if hdr_h < dv_h:
            crop_amount = (dv_h - hdr_h) // 2
            print(f'\n\nLetterboxing needed - {crop_amount} | HDR - {hdr_h} | DV - {dv_h}')
        else:
            crop_amount = (hdr_h - dv_h) // 2
            crop = True
            print(f'\n\nCropping needed - {crop_amount} | HDR - {hdr_h} | DV - {dv_h}')

    if delay:
        delay_frames = delay_to_frames(delay,frame_rate)
        print(f'Delay: {delay_frames} Frames')


    if delay < 0:
        remove_frames = "0-" + str(abs(delay_frames)-1)
        delay_frames = 0

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
                "length": delay_frames
            }]}

    if (
        delay_frames 
        or remove_frames 
        or crop_amount > 0
        ):
        rpu_json = os.path.join(main_folder,'rpu.json')
        with open(rpu_json, "w+",encoding='utf-8') as outfile: outfile.write(json.dumps(json_data, indent=4))
        print('\n\nEditing RPU')
        RPU_EDITED_PATH = os.path.join(main_folder,'rpu_edited.bin')   
        subprocess.run([DV_TOOL,'editor',"-i",RPU_PATH,"-o",RPU_EDITED_PATH,"-j",rpu_json])
        os.remove(RPU_PATH)
        os.remove(rpu_json)
        RPU_PATH = RPU_EDITED_PATH  
    
    return RPU_PATH

def hdr_operations(hdr_file,delay,main_folder,plus=False):
    name = 'HDR10+'

    if not plus:
        name = 'HDR'

    HI = get_mediainfo(hdr_file)
    HVI = get_vid_info(HI)

    if not HVI:
        print(f'No Video Streams Found in {hdr_file}')
        return
    
    if HI.media.track[0].format.lower() == "hevc":
        hdr_raw = hdr_file
    else:
        hdr_raw = os.path.join(main_folder,name+'.hevc')
        print(f'\n\nDemuxing {name}')
        if demux_file(hdr_file,HVI.id,hdr_raw):
            return

    if not plus:
        return hdr_raw

    M_JSON = os.path.join(main_folder,'metadata.json')
    subprocess.run([HDR_TOOL,'extract',hdr_raw,'-o',M_JSON])

    os.remove(hdr_raw)

    frame_rate = get_fps(HVI)
    delay_frames = 0
    remove_frames = ""

    if delay:
        delay_frames = delay_to_frames(delay,frame_rate)
        print(f'Delay: {delay_frames} Frames')

    if delay < 0:
        remove_frames = "0-" + str(abs(delay_frames)-1)
        delay_frames = 0    

    hjson = {
                "remove": [
                    remove_frames,
                ],

                "duplicate": [
                    {
                        "source": 0,
                        "offset": 0,
                        "length": delay_frames
                    }
                ]
            }
    
    if remove_frames or delay_frames: 
        rpu_json = os.path.join(main_folder,'edits.json')
        with open(rpu_json, "w+",encoding='utf-8') as outfile: 
            outfile.write(json.dumps(hjson, indent=4))
        HRPU_EDITED_PATH = os.path.join(main_folder,'metadata_edited.json')
        subprocess.run([HDR_TOOL,"editor",M_JSON,'-j',rpu_json,'-o',HRPU_EDITED_PATH])
        return HRPU_EDITED_PATH

def main(dv_file,hdr_file,output_path,delay,hdr10_file,hdr10_delay):
    main_folder = uniquify('dvhdr')
    os.mkdir(main_folder)

    if dv_file and not os.path.exists(dv_file):
        return print(f'{dv_file} Path Not Found')
    
    if hdr_file and not os.path.exists(hdr_file):
        return print(f'{hdr_file} Path Not Found')
    
    if hdr10_file and not os.path.exists(hdr_file):
        return print(f'{hdr10_file} Path Not Found')
    
    RPU_PATH ,HDR_RAW ,HDR_RPU = None,None,None 

    if hdr_file:
        HDR_RAW = hdr_operations(hdr_file,0,main_folder)

    if hdr10_file:
        HDR_RPU = hdr_operations(hdr10_file,hdr10_delay,main_folder,plus=True)
    
    if dv_file == hdr_file:
        RPU_PATH =  DOVI_OPERATIONS(HDR_RAW,hdr_file,delay,main_folder)

    if HDR_RPU:
        print('\n\nInjecting HDR10+ RPU')
        hdr10_injected = os.path.join(main_folder,'hdr10INJ.hevc')

        subprocess.run([HDR_TOOL,"inject","-i",HDR_RAW,'-j',HDR_RPU,'-o',hdr10_injected]) 
        rvf(HDR_RAW)
        HDR_RAW = hdr10_injected

    if dv_file:
        if not RPU_PATH:
            RPU_PATH =  DOVI_OPERATIONS(dv_file,hdr_file,delay,main_folder)

        print('\n\nInjecting DV RPU')
        dvhdr_raw = os.path.join(main_folder,'dvhdr.hevc')        
        subprocess.run([DV_TOOL,'inject-rpu','-i',HDR_RAW,'--rpu-in',RPU_PATH,'-o',dvhdr_raw])
        if dv_file != hdr_file:
            os.remove(HDR_RAW)
        HDR_RAW = dvhdr_raw
    
    HI = get_mediainfo(hdr_file)
    HVI = get_vid_info(HI)
    frame_rate = get_fps(HVI)
    language = getattr(HVI, 'language', "und")
    subprocess.run([
        MKV_MERGE,
        '--output',
        output_path,
        '--no-date',
        '--default-duration',
        f'0:{frame_rate}fps',
        '--language',
        f'0:{language}',
        HDR_RAW,
        '-D',
        hdr_file
    ])
    if os.path.exists(output_path):
        print('Process Completed')
    
    shutil.rmtree(main_folder)


arguments = argparse.ArgumentParser()
arguments.add_argument("-o", '--output', dest="output", help="Specify output file name", default=False)
arguments.add_argument("-hdr", '--hdr', dest="hdr", help="HDR File Path", )
arguments.add_argument("-dv", '--dovi', dest="dv", help="DV File Path",)
arguments.add_argument("-hdrp", '--hdrp', dest="hdrp", help="HDR10+ File Path",)
arguments.add_argument("-delay", '--d', dest="delay", help="Dovi Delay",)
arguments.add_argument("-delayh10p", '--dh10p', dest="dhdrp", help="HDR10+ Delay",)
args = arguments.parse_args()


hdrfile = args.hdr if args.hdr else input(f"Enter HDR File Path: ")
dvfile = args.dv if args.dv else None
hdrp = args.hdrp if args.hdrp else None
output = args.output if args.output else input("Enter Output File Path: ")
output  = output+".mkv" if not output.endswith('.mkv') else output

dhdrp = float(args.dhdrp) if args.dhdrp else 0
delay = float(args.delay) if args.delay else 0

main(dvfile,hdrfile,output,delay,hdrp,dhdrp)
