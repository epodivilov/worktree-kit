#!/bin/sh
set -e

REPO="epodivilov/worktree-kit"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="wt"

main() {
    detect_platform
    setup_install_dir
    download_binary
    install_binary
    print_success
}

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        darwin) OS="darwin" ;;
        linux) OS="linux" ;;
        *)
            echo "Error: Unsupported OS: $OS"
            echo "Supported: macOS, Linux"
            exit 1
            ;;
    esac

    case "$ARCH" in
        x86_64|amd64) ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)
            echo "Error: Unsupported architecture: $ARCH"
            echo "Supported: x64, arm64"
            exit 1
            ;;
    esac

    BINARY="wt-${OS}-${ARCH}"
    echo "Detected: ${OS}/${ARCH}"
}

setup_install_dir() {
    if [ ! -d "$INSTALL_DIR" ]; then
        echo "Creating $INSTALL_DIR..."
        mkdir -p "$INSTALL_DIR"
    fi
}

download_binary() {
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
    TMP_FILE=$(mktemp)

    echo "Downloading ${BINARY}..."

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$DOWNLOAD_URL" -O "$TMP_FILE"
    else
        echo "Error: curl or wget required"
        exit 1
    fi
}

install_binary() {
    TARGET="$INSTALL_DIR/$BINARY_NAME"

    mv "$TMP_FILE" "$TARGET"
    chmod +x "$TARGET"

    # Remove macOS quarantine attribute
    if [ "$OS" = "darwin" ]; then
        xattr -d com.apple.quarantine "$TARGET" 2>/dev/null || true
    fi
}

print_success() {
    echo ""
    echo "Installed: $TARGET"
    echo ""

    # Check if install dir is in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
            echo "Add to your shell config:"
            echo ""
            echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            echo ""
            ;;
    esac

    echo "Run 'wt --help' to get started"
}

main
