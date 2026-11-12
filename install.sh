#!/bin/sh
# sonora — single-command installer
#
# Quick start:
#   curl -fsSL https://raw.githubusercontent.com/karutoil/sonora/master/install.sh | bash
#
# Or run from inside a cloned repository:
#   ./install.sh
#
# Flags:
#   --no-start          Set up files and .env without starting containers
#   --help, -h          Show this help message
#
# Options (via environment):
#   SONORA_DIR          Installation directory (default: ./sonora, or current dir if inside repo)
#   SONORA_USER         Bootstrap username (default: admin)
#   SONORA_PASSPHRASE   Bootstrap passphrase (prompted or generated if unset)
#   SONORA_BIND         Host address to bind to (default: 127.0.0.1)

set -eu

NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-start)
      NO_START=1
      ;;
    --help|-h)
      echo "Usage: install.sh [--no-start]"
      echo ""
      echo "Options (via environment):"
      echo "  SONORA_DIR          Target directory (default: ./sonora)"
      echo "  SONORA_USER         Admin account name (default: admin)"
      echo "  SONORA_PASSPHRASE   Admin passphrase (prompted or generated if unset)"
      echo "  SONORA_BIND         Bind address (default: 127.0.0.1)"
      exit 0
      ;;
  esac
done

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

# Disable colours if stdout is not a terminal
if [ ! -t 1 ]; then
  BOLD=""
  GREEN=""
  YELLOW=""
  CYAN=""
  RED=""
  RESET=""
fi

info() {
  printf "${CYAN}==>${RESET} ${BOLD}%s${RESET}\n" "$*"
}

success() {
  printf "${GREEN}==>${RESET} ${BOLD}%s${RESET}\n" "$*"
}

warn() {
  printf "${YELLOW}warning:${RESET} %s\n" "$*" >&2
}

err() {
  printf "${RED}error:${RESET} %s\n" "$*" >&2
  exit 1
}

REPO_URL="${SONORA_REPO:-https://github.com/karutoil/sonora.git}"
BRANCH="${SONORA_BRANCH:-master}"

# ── 1. Determine working directory ──────────────────────────────────────────

# If we are already inside a sonora repository checkout:
if [ -f "compose.yaml" ] && [ -f "Containerfile" ] && [ -f "package.json" ]; then
  TARGET_DIR="$(pwd)"
  info "Running inside existing sonora directory: $TARGET_DIR"
else
  TARGET_DIR="${SONORA_DIR:-sonora}"
  if [ -d "$TARGET_DIR" ] && [ -f "$TARGET_DIR/compose.yaml" ]; then
    info "Using existing sonora directory: $TARGET_DIR"
    cd "$TARGET_DIR"
  else
    info "Setting up sonora in: $TARGET_DIR"
    if command -v git >/dev/null 2>&1; then
      git clone -b "$BRANCH" "$REPO_URL" "$TARGET_DIR" 2>/dev/null || \
        git clone "$REPO_URL" "$TARGET_DIR" || \
        err "Failed to clone $REPO_URL. Ensure the repository exists and is accessible."
      cd "$TARGET_DIR"
    elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
      mkdir -p "$TARGET_DIR"
      ARCHIVE_URL="${SONORA_ARCHIVE_URL:-https://github.com/karutoil/sonora/archive/refs/heads/$BRANCH.tar.gz}"
      if ! curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TARGET_DIR" --strip-components=1 2>/dev/null; then
        curl -fsSL "https://github.com/karutoil/sonora/archive/refs/heads/main.tar.gz" | tar -xz -C "$TARGET_DIR" --strip-components=1 || \
          err "Failed to download sonora archive from GitHub."
      fi
      cd "$TARGET_DIR"
    else
      err "Neither 'git' nor 'curl'+'tar' found. Please install git or curl and tar first."
    fi
  fi
fi

# ── 2. Detect container engine ──────────────────────────────────────────────

COMPOSE_CMD=""
ENGINE_TYPE=""

# Check for Podman first (preferred on rootless Linux)
if command -v podman >/dev/null 2>&1; then
  if podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD="podman compose -f compose.yaml -f compose.podman.yaml"
    ENGINE_TYPE="podman"
  elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE_CMD="podman-compose -f compose.yaml -f compose.podman.yaml"
    ENGINE_TYPE="podman"
  fi
fi

# Fall back to Docker if Podman compose wasn't detected
if [ -z "$COMPOSE_CMD" ] && command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    ENGINE_TYPE="docker"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
    ENGINE_TYPE="docker"
  fi
fi

if [ -z "$COMPOSE_CMD" ]; then
  warn "No container engine (Docker or Podman with compose) was detected."
  if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | sed 's/^v//')
    info "Found Node.js $NODE_VER. You can run sonora locally with:"
    info "  npm ci && npm start"
  fi
  err "Please install Docker (https://docs.docker.com/get-docker/) or Podman (https://podman.io/) to proceed."
fi

info "Detected container engine: $ENGINE_TYPE ($COMPOSE_CMD)"

# ── 3. Configure .env ───────────────────────────────────────────────────────

mkdir -p data/audio

GEN_PASS=0
PASSPHRASE="${SONORA_PASSPHRASE:-}"
USER_NAME="${SONORA_USER:-admin}"
BIND_ADDR="${SONORA_BIND:-}"

if [ ! -f .env ]; then
  info "Creating .env configuration..."
  cp .env.example .env

  # Generate random 32-byte hex secret
  if command -v openssl >/dev/null 2>&1; then
    SECRET=$(openssl rand -hex 32)
  else
    SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  fi

  # Determine passphrase
  if [ -z "$PASSPHRASE" ]; then
    # Only attempt reading from /dev/tty if a controlling terminal is actually available
    if (exec < /dev/tty) 2>/dev/null; then
      printf "\n${BOLD}Create admin passphrase${RESET} (leave blank to auto-generate): " > /dev/tty
      read -r PASSPHRASE < /dev/tty || true
      printf "\n" > /dev/tty
    fi
  fi

  if [ -z "$PASSPHRASE" ]; then
    if command -v openssl >/dev/null 2>&1; then
      PASSPHRASE=$(openssl rand -hex 16)
    else
      PASSPHRASE=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    fi
    GEN_PASS=1
  fi

  # Write variables safely into .env
  awk -v secret="$SECRET" -v user="$USER_NAME" -v pass="$PASSPHRASE" -v bind="$BIND_ADDR" '
    /^SONORA_SECRET=/ { print "SONORA_SECRET=" secret; next }
    /^SONORA_USER=/ { print "SONORA_USER=" user; next }
    /^SONORA_PASSPHRASE=/ { print "SONORA_PASSPHRASE=" pass; next }
    /^SONORA_BIND=/ { if (bind != "") print "SONORA_BIND=" bind; else print; next }
    { print }
  ' .env.example > .env.tmp && mv .env.tmp .env

else
  info "Found existing .env file. Preserving existing settings."
  # Ensure SONORA_SECRET is populated if empty
  if grep -q "^SONORA_SECRET=[[:space:]]*$" .env; then
    if command -v openssl >/dev/null 2>&1; then
      SECRET=$(openssl rand -hex 32)
    else
      SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    fi
    sed -i "s|^SONORA_SECRET=.*|SONORA_SECRET=$SECRET|" .env
  fi
  # Read existing user/pass for summary display if available
  EXISTING_USER=$(grep -E "^SONORA_USER=" .env | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  if [ -n "$EXISTING_USER" ]; then USER_NAME="$EXISTING_USER"; fi
  EXISTING_PASS=$(grep -E "^SONORA_PASSPHRASE=" .env | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  if [ -n "$EXISTING_PASS" ]; then PASSPHRASE="$EXISTING_PASS"; fi
fi

# ── 4. Build and start containers ───────────────────────────────────────────

if [ "$NO_START" -eq 1 ]; then
  info "--no-start specified. Skipping container startup."
  info "To start sonora, run:"
  info "  $COMPOSE_CMD up -d --build"
  exit 0
fi

info "Building and starting sonora container..."
$COMPOSE_CMD up -d --build

# ── 5. Healthcheck ──────────────────────────────────────────────────────────

info "Waiting for sonora to become healthy..."
HEALTHY=0
for i in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS http://127.0.0.1:8130/api/health >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O /dev/null http://127.0.0.1:8130/api/health >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
  fi
  sleep 1
done

# ── 6. Completion banner ────────────────────────────────────────────────────

printf "\n"
printf "${GREEN}============================================================${RESET}\n"
printf "${GREEN}               Sonora is up and running!                    ${RESET}\n"
printf "${GREEN}============================================================${RESET}\n\n"

printf "  ${BOLD}URL:${RESET}         http://127.0.0.1:8130\n"
printf "  ${BOLD}Username:${RESET}    %s\n" "$USER_NAME"
if [ -n "$PASSPHRASE" ]; then
  printf "  ${BOLD}Passphrase:${RESET}  %s\n" "$PASSPHRASE"
  if [ "$GEN_PASS" -eq 1 ]; then
    printf "               ${YELLOW}(auto-generated; saved in .env)${RESET}\n"
  fi
else
  printf "  ${BOLD}Passphrase:${RESET}  (configured in .env)\n"
fi
printf "\n"
printf "  ${BOLD}Location:${RESET}    %s\n" "$(pwd)"
printf "\n"
printf "  ${BOLD}Management commands:${RESET}\n"
printf "    %s logs -f     # Follow logs\n" "$COMPOSE_CMD"
printf "    %s down        # Stop server (data kept in ./data)\n" "$COMPOSE_CMD"
printf "    %s up -d       # Start server\n" "$COMPOSE_CMD"
printf "\n"
printf "${GREEN}============================================================${RESET}\n\n"

if [ "$HEALTHY" -eq 0 ]; then
  warn "Server did not answer /api/health within 30s."
  warn "Check logs with: $COMPOSE_CMD logs"
fi
