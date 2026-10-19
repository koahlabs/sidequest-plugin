import type { ClientModule } from "claude-code";

// Draws nothing. It runs only while the band tree is drawn, and posts once per ad.
const Seen: ClientModule<{ impressionId: string }, string> = (props, surface) => {
  if (surface.state !== props.impressionId) {
    surface.setState(props.impressionId);
    surface.post({ seen: props.impressionId });
  }
  return surface.elements.Text({ children: "" });
};

export default Seen;
