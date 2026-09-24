#!/bin/sh
# Installs Maestro for the current user: curl -fsSL https://raw.githubusercontent.com/hallygtree/maestro/main/install.sh | sh
set -eu

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Maestro supports Linux and macOS here (Windows: use install.ps1)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

dir="${XDG_DATA_HOME:-$HOME/.local/share}/maestro"
bin="$HOME/.local/bin"
url="https://github.com/hallygtree/maestro/releases/latest/download/maestro-$os-$arch.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL "$url" | tar -xz -C "$tmp"

rm -rf "$dir"
mkdir -p "$(dirname "$dir")" "$bin"
mv "$tmp/maestro" "$dir"
# The bundled node stays out of PATH; only this launcher goes in.
printf '#!/bin/sh\nexec "%s/node" "%s/src/cli.ts" "$@"\n' "$dir" "$dir" > "$bin/maestro"
chmod +x "$bin/maestro"
echo "Maestro installed in $dir"

case ":$PATH:" in
  *":$bin:"*) echo "Run: maestro" ;;
  *)
    line='export PATH="$HOME/.local/bin:$PATH"'
    case "${SHELL##*/}" in
      zsh) rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
      *) rc="" ;;
    esac
    if [ -n "$rc" ]; then
      grep -qsF "$line" "$rc" || printf '\n%s\n' "$line" >> "$rc"
      echo "Added $bin to PATH in $rc. Open a new terminal and run: maestro"
    else
      echo "Add $bin to your PATH ($line), then run: maestro"
    fi
    ;;
esac
