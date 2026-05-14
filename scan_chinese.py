#!/usr/bin/env python3
"""
Scan all files in the workspace for Chinese characters and output results to text files.
Each output file contains max 5 entries.
"""

import os
import re
import sys

# Chinese character regex pattern (covers CJK Unified Ideographs)
CHINESE_PATTERN = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\U00020000-\U0002a6df\U0002a700-\U0002b73f\U0002b740-\U0002b81f\U0002b820-\U0002ceaf\uf900-\ufaff]')

# Base directory to scan
BASE_DIR = '/home/guokoko/github/GCMP'

# Output directory
OUTPUT_DIR = '/home/guokoko/github/GCMP/found_cn'

# Directories to exclude
EXCLUDE_DIRS = {'node_modules', '.git', 'working', '.vscode', '.roo', '.github', 'fonts'}

# Max entries per output file
MAX_ENTRIES_PER_FILE = 50


def find_chinese_in_file(file_path, relative_path):
    """Scan a single file for Chinese characters and return list of (line_num, chinese_text) tuples."""
    results = []
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            for line_num, line in enumerate(f, start=1):
                matches = CHINESE_PATTERN.findall(line)
                if matches:
                    chinese_text = ''.join(matches)
                    results.append((line_num, chinese_text))
    except (IOError, OSError) as e:
        print(f"Warning: Could not read file {file_path}: {e}", file=sys.stderr)
    return results


def scan_directory(base_dir):
    """Recursively scan directory for files containing Chinese characters."""
    all_results = []
    
    for root, dirs, files in os.walk(base_dir):
        # Filter out excluded directories
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        
        for filename in files:
            file_path = os.path.join(root, filename)
            relative_path = os.path.relpath(file_path, base_dir)
            
            # Skip binary files and non-text files
            if filename.endswith(('.png', '.jpg', '.jpeg', '.gif', '.ico', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.bin', '.exe', '.dll', '.so')):
                continue
            
            chinese_results = find_chinese_in_file(file_path, relative_path)
            if chinese_results:
                all_results.append((relative_path, chinese_results))
    
    return all_results


def write_output(all_results, output_dir):
    """Write results to output files, max MAX_ENTRIES_PER_FILE entries per file."""
    os.makedirs(output_dir, exist_ok=True)
    
    # Flatten all entries
    all_entries = []
    for relative_path, chinese_results in all_results:
        for line_num, chinese_text in chinese_results:
            all_entries.append((relative_path, line_num, chinese_text))
    
    # Split into chunks of MAX_ENTRIES_PER_FILE
    output_files = []
    for i in range(0, len(all_entries), MAX_ENTRIES_PER_FILE):
        chunk = all_entries[i:i + MAX_ENTRIES_PER_FILE]
        output_files.append(chunk)
    
    # Write each chunk to a file
    for file_index, entries in enumerate(output_files, start=1):
        output_file = os.path.join(output_dir, f'found_cn_{file_index}.txt')
        with open(output_file, 'w', encoding='utf-8') as f:
            for relative_path, line_num, chinese_text in entries:
                f.write(f"{relative_path} at line {line_num} : {chinese_text}\n")
    
    return len(output_files)


def main():
    print(f"Scanning directory: {BASE_DIR}")
    print(f"Excluding directories: {', '.join(EXCLUDE_DIRS)}")
    print(f"Output directory: {OUTPUT_DIR}")
    print(f"Max entries per file: {MAX_ENTRIES_PER_FILE}")
    print()
    
    all_results = scan_directory(BASE_DIR)
    
    if not all_results:
        print("No Chinese characters found in any files.")
        return
    
    total_entries = sum(len(results) for _, results in all_results)
    print(f"Found Chinese characters in {len(all_results)} files ({total_entries} total occurrences)")
    print()
    
    # Print summary
    for relative_path, chinese_results in all_results:
        print(f"{relative_path}: {len(chinese_results)} occurrence(s)")
        for line_num, chinese_text in chinese_results[:3]:  # Show first 3
            print(f"  Line {line_num}: {chinese_text}")
        if len(chinese_results) > 3:
            print(f"  ... and {len(chinese_results) - 3} more")
    
    print()
    
    num_output_files = write_output(all_results, OUTPUT_DIR)
    print(f"Results written to {num_output_files} file(s) in {OUTPUT_DIR}/")
    print("Files: " + ", ".join([f"found_cn_{i}.txt" for i in range(1, num_output_files + 1)]))


if __name__ == '__main__':
    main()
