#!/usr/bin/env bash
# Discarr native installer
# Installs Node.js 18+, ffmpeg, HandBrake CLI, and DVD libraries,
# then optionally registers Discarr as a systemd service.
#
# Supported: Ubuntu/Debian (apt), Fedora/RHEL (dnf), Arch (pacman), macOS (brew)
# Run as root or with sudo.

set -euo pipefail

DISCARR_INSTALL_DIR="${DISCARR_INSTALL_DIR:-/opt/discarr}"
DISCARR_USER="${DISCARR_USER:-discarr}"
DISCARR_PORT="${DISCARR_PORT:-8603}"
REGISTER_SERVICE="${REGISTER_SERVICE:-ask}"   # ask | yes | no

# ── Colours ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}→${NC}  $*"; }
success() { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
die()     { echo -e "${RED}✗${NC}  $*" >&2; exit 1; }

# ── Root check ─────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root or with sudo."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Detect package manager ─────────────────────────────────────────────────────
detect_pm() {
    if   command -v apt-get &>/dev/null; then echo "apt"
    elif command -v dnf     &>/dev/null; then echo "dnf"
    elif command -v pacman  &>/dev/null; then echo "pacman"
    elif command -v brew    &>/dev/null; then echo "brew"
    else die "Unsupported package manager. Install deps manually and re-run with SKIP_DEPS=1."
    fi
}
PM=$(detect_pm)
info "Package manager: $PM"

# ── Node.js 18+ ────────────────────────────────────────────────────────────────
install_node() {
    if command -v node &>/dev/null; then
        local ver
        ver=$(node --version | sed 's/v//' | cut -d. -f1)
        if [[ $ver -ge 18 ]]; then
            success "Node.js $(node --version) already installed."
            return
        fi
        warn "Node.js $ver found but >=18 required. Upgrading via NodeSource."
    fi

    info "Installing Node.js 20 LTS via NodeSource..."
    case $PM in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
            ;;
        dnf)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
            dnf install -y nodejs
            ;;
        pacman)
            pacman -Sy --noconfirm nodejs npm
            ;;
        brew)
            brew install node@20
            brew link --overwrite node@20
            ;;
    esac
    success "Node.js $(node --version) installed."
}

# ── ffmpeg + ffprobe ───────────────────────────────────────────────────────────
install_ffmpeg() {
    if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
        success "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}') already installed."
        return
    fi
    info "Installing ffmpeg..."
    case $PM in
        apt)    apt-get install -y ffmpeg ;;
        dnf)
            # ffmpeg is in RPM Fusion — enable if not already
            if ! dnf repolist enabled | grep -q rpmfusion-free; then
                dnf install -y \
                    "https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm" \
                    "https://mirrors.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm"
            fi
            dnf install -y ffmpeg
            ;;
        pacman) pacman -Sy --noconfirm ffmpeg ;;
        brew)   brew install ffmpeg ;;
    esac
    success "ffmpeg installed."
}

# ── HandBrake CLI (optional but recommended for HEVC encoding) ─────────────────
install_handbrake() {
    if command -v HandBrakeCLI &>/dev/null || command -v handbrake-cli &>/dev/null; then
        success "HandBrake CLI already installed."
        return
    fi
    info "Installing HandBrake CLI..."
    case $PM in
        apt)
            # handbrake-cli is in universe on Ubuntu 20.04+
            apt-get install -y handbrake-cli 2>/dev/null || {
                warn "handbrake-cli not found in apt — skipping. You can install it manually:"
                warn "  https://handbrake.fr/downloads.php"
            }
            ;;
        dnf)
            # Requires RPM Fusion (already enabled for ffmpeg)
            dnf install -y HandBrake-cli 2>/dev/null || warn "HandBrake-cli not found — skipping."
            ;;
        pacman)
            pacman -Sy --noconfirm handbrake-cli 2>/dev/null || warn "handbrake-cli not found — skipping."
            ;;
        brew)
            brew install handbrake 2>/dev/null || warn "HandBrake not found in brew — skipping."
            ;;
    esac
}

# ── DVD libraries (libdvdcss, libdvdread, libdvdnav) ──────────────────────────
install_dvd_libs() {
    info "Installing DVD libraries (libdvdcss, libdvdread, libdvdnav)..."
    case $PM in
        apt)
            apt-get install -y libdvd-pkg libdvdread8 libdvdnav4 2>/dev/null || \
                apt-get install -y libdvdread-dev libdvdnav-dev 2>/dev/null || true
            # libdvd-pkg builds libdvdcss from source (legal in most jurisdictions)
            if dpkg -l libdvd-pkg &>/dev/null 2>&1; then
                DEBIAN_FRONTEND=noninteractive dpkg-reconfigure libdvd-pkg 2>/dev/null || true
            fi
            ;;
        dnf)
            if ! dnf repolist enabled | grep -q rpmfusion; then
                warn "RPM Fusion not enabled — skipping libdvdcss. Enable RPM Fusion and run: dnf install libdvdcss"
            else
                dnf install -y libdvdcss libdvdread libdvdnav 2>/dev/null || true
            fi
            ;;
        pacman)
            # libdvdcss is in extra; others in core
            pacman -Sy --noconfirm libdvdcss libdvdread libdvdnav 2>/dev/null || true
            ;;
        brew)
            brew install libdvdcss 2>/dev/null || warn "libdvdcss not available via brew — skipping."
            ;;
    esac
    success "DVD libraries done (some may need manual install — see README)."
}

# ── Install Discarr app files ──────────────────────────────────────────────────
install_app() {
    info "Installing Discarr to $DISCARR_INSTALL_DIR..."
    mkdir -p "$DISCARR_INSTALL_DIR"
    cp -r "$SCRIPT_DIR"/server.js "$SCRIPT_DIR"/scanner.js "$SCRIPT_DIR"/public \
          "$SCRIPT_DIR"/scripts "$SCRIPT_DIR"/api-keys.conf.example \
          "$DISCARR_INSTALL_DIR"/

    # Create a launcher wrapper
    cat > /usr/local/bin/discarr <<EOF
#!/usr/bin/env bash
exec node "$DISCARR_INSTALL_DIR/server.js" "\$@"
EOF
    chmod +x /usr/local/bin/discarr
    success "Discarr installed to $DISCARR_INSTALL_DIR"
    info "Run: discarr   (or: node $DISCARR_INSTALL_DIR/server.js)"
}

# ── Systemd service ───────────────────────────────────────────────────────────
# TODO: Fill in the service unit that fits your deployment model.
# Design choices to consider:
#   - User service (runs as a dedicated `discarr` user, more secure) vs.
#     system service (runs as root, simpler but higher privilege)
#   - Restart policy: always? on-failure only?
#   - WantedBy: multi-user.target (boot) or a media mount target?
#   - Should DISCARR_PORT / DISCARR_CONFIG be baked in or read from an EnvironmentFile?
register_service() {
    local SERVICE_FILE="/etc/systemd/system/discarr.service"
    info "Registering systemd service..."

    # Create service user if using dedicated user model
    if ! id "$DISCARR_USER" &>/dev/null; then
        useradd -r -s /bin/false -d "$DISCARR_INSTALL_DIR" "$DISCARR_USER"
        chown -R "$DISCARR_USER:$DISCARR_USER" "$DISCARR_INSTALL_DIR"
    fi

    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Discarr — disc rip to Sonarr/Radarr pipeline
After=network.target

[Service]
Type=simple
User=${DISCARR_USER}
WorkingDirectory=${DISCARR_INSTALL_DIR}
ExecStart=$(command -v node) ${DISCARR_INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5
Environment=PORT=${DISCARR_PORT}
EnvironmentFile=-/etc/discarr/env

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable discarr
    systemctl start  discarr
    success "Service registered. Status: $(systemctl is-active discarr)"
    info "Logs: journalctl -u discarr -f"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
    echo
    echo -e "${CYAN}╔══════════════════════════════╗${NC}"
    echo -e "${CYAN}║   Discarr installer v0.1.0   ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════╝${NC}"
    echo

    if [[ "${SKIP_DEPS:-0}" != "1" ]]; then
        install_node
        install_ffmpeg
        install_handbrake
        install_dvd_libs
    fi

    install_app

    # Service registration
    if [[ $PM == "brew" ]]; then
        info "macOS: skipping systemd. Run with: discarr"
    elif [[ $REGISTER_SERVICE == "ask" ]]; then
        read -rp "Register as systemd service? [y/N] " ans
        [[ ${ans,,} == "y" ]] && register_service
    elif [[ $REGISTER_SERVICE == "yes" ]]; then
        register_service
    fi

    echo
    echo -e "${GREEN}Discarr is ready.${NC}"
    echo -e "  Open: ${CYAN}http://localhost:${DISCARR_PORT}${NC}"
    echo -e "  Config: ${CYAN}~/.config/media-postprocessor/api-keys.conf${NC}"
    echo -e "  Example: ${CYAN}${DISCARR_INSTALL_DIR}/api-keys.conf.example${NC}"
    echo
}

main "$@"
