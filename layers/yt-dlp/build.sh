#!/bin/bash
# Build yt-dlp + ffmpeg Lambda Layer for Amazon Linux 2023
# Run this script on an Amazon Linux 2023 instance or use Docker

set -e

LAYER_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${LAYER_DIR}/build"
OUTPUT_FILE="${LAYER_DIR}/layer.zip"

echo "🔧 Building yt-dlp + ffmpeg Lambda Layer..."

# Clean previous builds
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}/bin"

# Download yt-dlp standalone binary
echo "📥 Downloading yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  -o "${BUILD_DIR}/bin/yt-dlp"
chmod +x "${BUILD_DIR}/bin/yt-dlp"

# Download ffmpeg static build
echo "📥 Downloading ffmpeg..."
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
  -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp
cp /tmp/ffmpeg-*-amd64-static/ffmpeg "${BUILD_DIR}/bin/"
cp /tmp/ffmpeg-*-amd64-static/ffprobe "${BUILD_DIR}/bin/"
chmod +x "${BUILD_DIR}/bin/ffmpeg" "${BUILD_DIR}/bin/ffprobe"
rm -rf /tmp/ffmpeg*

# Create layer zip
echo "📦 Creating layer.zip..."
cd "${BUILD_DIR}"
zip -r "${OUTPUT_FILE}" bin/
cd "${LAYER_DIR}"

# Cleanup
rm -rf "${BUILD_DIR}"

echo "✅ Layer built successfully: ${OUTPUT_FILE}"
echo "   Size: $(du -h "${OUTPUT_FILE}" | cut -f1)"
