export type KoahAd = {
  adText: string;
  adCta: string;
  adLink: string;
  advertiser: { name: string; rootDomain: string; iconUrl: string | null };
  /** UUID of the served ad; the mod builds the impression URL from it. */
  impressionId: string;
  /** The advertiser favicon as base64 PNG, fetched by the mod. */
  iconPng?: string;
  /** The favicon's average color as #rrggbb, for a badge where the terminal draws no image. */
  iconColor?: string;
};

/** One ad per answered turn, matched to its last message by the message id. */
export type AdSlot = { messageId: string; ad: KoahAd };

declare module "claude-code" {
  interface PluginState {
    sidequest: { slots: AdSlot[]; band: KoahAd | null };
  }
}
