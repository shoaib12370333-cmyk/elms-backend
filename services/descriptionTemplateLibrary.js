/**
 * The seller's "Description Template" (Settings -> Description Template): a starter style plus which "tool" blocks
 * to include, in what order, and the seller's own branding/raw content for the blocks that need real data rather
 * than AI-invented text. services/descriptionBeautifyService.js reads this to build the AI prompt and to splice in
 * the blocks that must never be guessed (gallery images, store banner, size chart, video).
 */

// Every block is either AI-written from the product's own facts (never invented), or spliced in afterwards from
// data the seller actually saved - a data block that has no real data behind it is simply left out, never guessed.
const AVAILABLE_BLOCKS = [
  { key: 'gallery', label: 'Image Gallery', kind: 'data', hint: 'The listing\'s own photos, placed where the AI leaves room for them.' },
  { key: 'bullets', label: 'Key Features / Bullets', kind: 'ai', hint: 'A short bulleted list of the product\'s real features.' },
  { key: 'specs', label: 'Specifications Table', kind: 'ai', hint: 'The product\'s saved specifications, as a table.' },
  { key: 'shipping', label: 'Shipping & Delivery', kind: 'ai', hint: 'A short, generic shipping note (no invented delivery promises).' },
  { key: 'returns', label: 'Returns & Warranty', kind: 'ai', hint: 'A short, generic returns note (no invented policy numbers).' },
  { key: 'trust_badges', label: 'Trust Badges', kind: 'ai', hint: 'Short reassurance line(s): buyer protection, secure checkout.' },
  { key: 'faq', label: 'FAQ', kind: 'ai', hint: 'A couple of generic buyer questions answered from the facts given.' },
  { key: 'store_banner', label: 'Store Banner / Logo', kind: 'data', hint: 'The seller\'s own store name and logo.' },
  { key: 'size_chart', label: 'Size Chart', kind: 'data', hint: 'The seller\'s own saved size chart HTML.' },
  { key: 'video', label: 'Video', kind: 'data', hint: 'A link to the seller\'s own saved product video.' },
  { key: 'custom_html', label: 'Custom HTML', kind: 'data', hint: 'The seller\'s own saved boilerplate (e.g. "why buy from us").' },
];
const BLOCK_KEYS = new Set(AVAILABLE_BLOCKS.map((b) => b.key));

const TEMPLATE_STYLES = [
  { id: 'minimal', name: 'Minimal / Clean', tone: 'calm and clean, short sentences, no emojis', defaultBlocks: ['bullets', 'specs', 'shipping'] },
  { id: 'bold', name: 'Bold / Sale-style', tone: 'confident and energetic, a little urgency, tasteful emoji use', defaultBlocks: ['trust_badges', 'store_banner', 'bullets', 'shipping', 'returns'] },
  { id: 'premium', name: 'Premium / Luxury', tone: 'elegant and refined, brand-forward, no emojis', defaultBlocks: ['store_banner', 'bullets', 'specs', 'custom_html', 'shipping', 'returns'] },
  { id: 'tech', name: 'Tech / Gadget', tone: 'precise and spec-forward, confident, minimal emojis', defaultBlocks: ['gallery', 'specs', 'bullets', 'custom_html', 'shipping', 'returns', 'faq'] },
  { id: 'fashion', name: 'Fashion / Apparel', tone: 'stylish and warm, light emoji use', defaultBlocks: ['gallery', 'size_chart', 'bullets', 'specs', 'shipping', 'returns'] },
  { id: 'kids', name: 'Kids / Toys', tone: 'playful and warm, reassuring for parents, light emoji use', defaultBlocks: ['gallery', 'bullets', 'specs', 'faq', 'shipping', 'returns'] },
  { id: 'home', name: 'Home & Kitchen', tone: 'practical and helpful, no emojis', defaultBlocks: ['gallery', 'bullets', 'specs', 'video', 'shipping', 'returns'] },
  { id: 'automotive', name: 'Automotive / Parts', tone: 'direct and technical, compatibility-focused, no emojis', defaultBlocks: ['gallery', 'custom_html', 'specs', 'bullets', 'faq', 'shipping', 'returns'] },
];
const STYLE_IDS = new Set(TEMPLATE_STYLES.map((s) => s.id));

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());

/** Cleans whatever the Settings page sent, always returning a usable, safe template - never throws. */
function normalizeTemplate(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const styleId = STYLE_IDS.has(raw.templateId) ? raw.templateId : TEMPLATE_STYLES[0].id;
  const style = TEMPLATE_STYLES.find((s) => s.id === styleId) || TEMPLATE_STYLES[0];
  const blocksIn = Array.isArray(raw.blocks) && raw.blocks.length ? raw.blocks : style.defaultBlocks;
  const blocks = Array.from(new Set(blocksIn.map((b) => String(b || '').trim()).filter((b) => BLOCK_KEYS.has(b)))).slice(0, AVAILABLE_BLOCKS.length);
  const brandingIn = raw.branding && typeof raw.branding === 'object' ? raw.branding : {};
  return {
    templateId: styleId,
    blocks: blocks.length ? blocks : style.defaultBlocks,
    branding: {
      storeName: String(brandingIn.storeName || '').trim().slice(0, 120),
      logoUrl: isHttpUrl(brandingIn.logoUrl) ? String(brandingIn.logoUrl).trim().slice(0, 500) : '',
      accentColor: HEX_COLOR.test(String(brandingIn.accentColor || '').trim()) ? String(brandingIn.accentColor).trim() : '#111111',
    },
    customHtml: String(raw.customHtml || '').trim().slice(0, 2000),
    sizeChartHtml: String(raw.sizeChartHtml || '').trim().slice(0, 4000),
    videoUrl: isHttpUrl(raw.videoUrl) ? String(raw.videoUrl).trim().slice(0, 500) : '',
  };
}

module.exports = { AVAILABLE_BLOCKS, TEMPLATE_STYLES, normalizeTemplate };
