# Model access offered by witden inside this computer (off unless enabled for the computer). The runner
# writes the local endpoint and the computer's key here; shells export them for the programs they start.
if [ -r "$HOME/.config/witden/model-proxy.env" ]; then
  set -a
  . "$HOME/.config/witden/model-proxy.env"
  set +a
fi
