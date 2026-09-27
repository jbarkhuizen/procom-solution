// Category rules for SMD's pricelists, used by smd-autolist.js.
//
// SMD's own "Category" column is too coarse for a shop menu (e.g. 257 of 286
// Infant Essential items are "Baby & Toddler"), so each row is matched by:
//   cat   -- SMD's category column (feed_items.category)
//   sheet -- the brand tab it came from (feed_items.source_sheet)
//   name  -- the product name
// All given tests must pass. First match wins, so ORDER MATTERS: specific
// rules sit above the catch-all for their SMD category. `skip` rules keep
// rows out of the shop and say why in the preview. `quote` marks a new
// category "delivery quoted after order" (only when the category is created).
//
// Parents are matched by name to the live category tree -- keep them
// spelled exactly as in Admin -> Categories, or a duplicate gets created.

const r = (parent, sub, test = {}, extra = {}) => ({ parent, sub, ...test, ...extra });
const skip = (reason, test) => ({ skip: reason, ...test });

const INFANT_RULES = [
  r('Toys & Games', 'Outdoor & Bubble Toys', { name: /^avalanche/i }),
  r('Health & Wellness', 'Adult Incontinence', { name: /lifree/i }),
  r('Home & Kitchen', 'Kitchen & Drinkware', { name: /loop & co/i }),
  r('Baby & Toddler', 'Nappy & Changing Bags', { name: /totes babe|diaper backpack|caddy|shoulder bag/i }),
  r('Baby & Toddler', 'Maternity & Breastfeeding', { name: /breast|nipple shield|nipple puller|nipple care|maternity|milk storage|milk saver|milk valve|lanolin|storage bag/i }),
  // "Bottles & Accessories Cleanser" is cleaning, not a bottle.
  r('Baby & Toddler', 'Sterilising & Cleaning', { name: /steril|cleanser|brush for|bottle brush|sponge bottle|nipple brush|laundry|straw brush|bottles & accessories/i }),
  r('Baby & Toddler', 'Bottles & Teats', { name: /bottle(?!s &)|nipple|nurser|teat|juice feeder|cleft palate|straw set|powder milk container/i }),
  r('Baby & Toddler', 'Feeding & Weaning', { name: /plate|bowl|spoon|fork|snack cup|straw cup|training cup|bib|food maker|weaning|feeding bundle|mag mag|feeding dish/i }),
  r('Baby & Toddler', 'Dummies & Teethers', { name: /pacifier|dummy|soother|teether/i }),
  r('Baby & Toddler', 'Oral Care', { name: /tooth|gum wipe/i }),
  r('Baby & Toddler', 'Health & Safety', { name: /thermometer|nose cleaner|nail sc|cooling sheet|mosquito lotion|mosquito patch|safety pin|comb|hairbrush|starter kit/i }),
  r('Baby & Toddler', 'Wipes', { name: /wipe|moisturi[sz]ing cloth/i }),
  r('Baby & Toddler', 'Bath & Skin Care', { name: /wash|shampoo|lotion|oil|cream|powder|gel|travel set|mist|serum|cotton/i }),
  r('Baby & Toddler', 'Blankets & Swaddles', { name: /blanket|swaddle/i }),
  r('Baby & Toddler', 'Baby Toys & Keepsakes', { name: /stacking|milestone card/i }),
  r('Baby & Toddler', 'Hair Accessories', { name: /headband/i }),
];

const CASH_RULES = [
  // --- never listed
  skip('Display stand, not for sale', { cat: /^Display Unit$/ }),
  skip('Supplier junk row', { cat: /^(Other|Fashion and beauty|Health and wellness|Vehicle Security System)$/ }),
  skip('Refurbished or consumable', { cat: /^Intangible$/ }),
  skip('Creality: listed from the Creality list', { sheet: /^Creality$/ }),

  // --- by product name, whatever SMD called it
  r('Computers & Peripherals', 'Laptops & Tablets', { cat: /^Devices$/, name: /^(?!.*(stand|lock|cool|cover|pillow|writing tablet|charger)).*(laptop|macbook|ipad|\btablet\b|acer (e10|14")|primebook|expertbook|lenovo v15)/i }),
  r('Computers & Peripherals', 'Storage & Memory', { name: /sd card|flash drive/i }),
  r('Mobile & Wearables', 'Phones', { name: /iphone 1\d|samsung (galaxy|s2\d|a0\d)/i }),
  r('Computers & Peripherals', 'PC Components', { name: /computer case|cpu cooler|atx/i }),
  r('Computers & Peripherals', 'Monitors', { name: /^(?!.*(mount|arm|rate monitor|humidity)).*monitor\b/i }),
  r('Computers & Peripherals', 'Laptop & Monitor Stands', { name: /monitor.*mount|monitor mount|laptop stand|notebook stand|cooling (stand|pad)|notebook cooling/i }),
  r('TV & Video', 'Projectors & Screens', { name: /projector/i }),
  r('Power & Electrical', 'Batteries', { name: /^(?!.*(insta360|power ?bank)).*batter(y|ies)|battery recharger/i }),
  r('Office & School', 'Label Printers', { name: /labelpro|label printer/i }),
  r('Smart Home & Lighting', 'Smart Home', { name: /photo frame|smart calendar/i }),
  r('Mobile & Wearables', 'Trackers & Tags', { name: /tagtrace/i }),
  r('Home & Kitchen', 'Heating & Cooling', { name: /turbo fan|handheld fan|portable fan/i }),
  r('Smart Home & Lighting', 'Lamps & Indoor Lighting', { name: /desk lamp/i }),
  r('Audio', 'Soundbars & Hi-Fi', { cat: /^Audio$/, name: /soundbar|theatre|subwoofer|hifi|hi-fi|turntable|radio/i }),
  r('Audio', 'Speakers', { cat: /^Audio$/, name: /party speaker/i }),
  r('Audio', 'Microphones & Karaoke', { cat: /^Audio$/, name: /microphone|karaoke/i }),
  r('Computers & Peripherals', 'Headsets & Audio', { cat: /^Computer (Peripherals|Accessories)$/, name: /headset|headphone|computer speaker|multimedia speaker|z\d{3}/i }),
  r('Audio', 'Earphones & Earbuds', { cat: /^(Mobile Accessories|Computer Accessories)$/, name: /earphone|\bbuds\b|tws/i }),
  r('Mobile & Wearables', 'Chargers & Cables', { cat: /^Electrical$/, name: /wall charger/i }),

  // --- by brand tab
  r('3D Printing', 'Filament', { sheet: /^SA Filament$/ }),
  r('Networking', 'Security Cameras', { sheet: /^VIGI$/ }),
  r('Networking', 'Business Switches & Access Points', { sheet: /^Omada$/ }),

  // --- by SMD category, specific first, then that category's catch-all
  r('Gaming', 'Gaming Chairs & Desks', { cat: /^Furniture$/ }, { quote: true }),
  r('Gaming', 'Gaming Headsets', { cat: /^Gaming$/, name: /headset|headphone|earbud|earphone/i }),
  r('Gaming', 'Gaming Mice & Keyboards', { cat: /^Gaming$/, name: /mouse|mice|keyboard|keypad|combo/i }),
  r('Gaming', 'Mouse Pads & Accessories', { cat: /^Gaming$/, name: /pad|mat|stand|holder|cable|bungee|light/i }),
  r('Gaming', 'Controllers & Racing', { cat: /^Gaming$/, name: /gamepad|controller|wheel|pedal|shifter|joystick|racing|moza|cockpit|flight/i }),
  r('Gaming', 'Handheld & Retro Consoles', { cat: /^Gaming$/, name: /handheld|arcade|console|retro|game/i }),
  r('Gaming', 'Gaming Accessories', { cat: /^Gaming$/ }),

  r('Audio', 'Earphones & Earbuds', { cat: /^Audio$/, name: /earphone|earbud|buds|tws|in-?ear|ows|air conduction|bone conduction|clef|note x/i }),
  r('Audio', 'Headphones', { cat: /^Audio$/, name: /headphone|headset|over-ear|on-ear|\banc\b|\bwh-|ult wear/i }),
  r('Audio', 'Speakers', { cat: /^Audio$/, name: /speaker|boombox|srs|\bult\b|field|xb\d|python|s\d00/i }),
  r('Audio', 'Audio Accessories', { cat: /^Audio$/ }),

  r('Networking', 'Switches', { cat: /^Networking$/, name: /switch|poe/i }),
  r('Networking', 'Routers & Mesh', { cat: /^Networking$/, name: /router|mesh|deco|halo|lte|4g|5g|archer|modem|vdsl/i }),
  r('Networking', 'Wi-Fi Extenders & Adapters', { cat: /^Networking$/, name: /extender|repeater|adapter|powerline|access point|usb|pci|antenna|re\d{3}|wa\d/i }),
  r('Networking', 'Networking Accessories', { cat: /^Networking$/ }),

  r('Smart Home & Lighting', 'Smart Home', { cat: /^Smart Home$/ }),
  r('Smart Home & Lighting', 'Light Bulbs', { cat: /^Lighting$/, name: /bulb|globe|lamp\b.*[be]\d\d|gu10|downlight|a60|candle|g45|mr16|tube/i }),
  r('Smart Home & Lighting', 'Outdoor & Flood Lights', { cat: /^Lighting$/, name: /flood|bulkhead|outdoor|solar|sensor|security light|wall light|garden|spot/i }),
  r('Smart Home & Lighting', 'Lamps & Indoor Lighting', { cat: /^Lighting$/ }),

  r('Power & Electrical', 'Multiplugs & Surge Protection', { cat: /^(Electrical|Electronics)$/, name: /multiplug|surge|way\b.*(plug|adaptor)|protector|ups|power strip/i }),
  r('Power & Electrical', 'Adaptors & Extension Leads', { cat: /^(Electrical|Electronics)$/, name: /adaptor|adapter|extension|lead|reel|cord|power cable|iec|travel/i }),
  r('Power & Electrical', 'Switches, Sockets & Wiring', { cat: /^(Electrical|Electronics)$/, name: /switch|socket|plug top|plug|wire|cable tie|sleeve|conduit|isolator|dimmer|box|cover|lever/i }),
  r('Power & Electrical', 'Electrical Accessories', { cat: /^(Electrical|Electronics)$/ }),

  r('TV & Video', 'TV Wall Mounts & Stands', { cat: /^Televisions$/, name: /mount|bracket|stand|trolley/i }),
  r('TV & Video', 'TV Cables & Accessories', { cat: /^Televisions$/ }),

  r('Cameras & Photography', 'Dash Cams', { cat: /^Photography$/, name: /dash/i }),
  r('Cameras & Photography', '360 & Action Cameras', { cat: /^Photography$/, name: /camera|cam\b|x\d .*bundle|flow|x5\b(?!.*(lens|mount|battery|adapter|grip|guard))|go ?3|ace pro|bundle|kit/i }),
  r('Cameras & Photography', 'Camera Accessories', { cat: /^Photography$/ }),

  r('Mobile & Wearables', 'Smart Rings & Glasses', { cat: /^Wearables$/, name: /ring|glasses/i }),
  r('Mobile & Wearables', 'Smartwatches', { cat: /^(Wearables|Sports and fitness)$/ }),
  r('Mobile & Wearables', 'Power Banks', { cat: /^Mobile Accessories$/, name: /power ?bank|mah/i }),
  r('Mobile & Wearables', 'Car Accessories', { cat: /^Mobile Accessories$/, name: /car|dash mount|vent|modulator/i }),
  r('Mobile & Wearables', 'Chargers & Cables', { cat: /^Mobile Accessories$/, name: /charg|cable|usb|type-?c|lightning|pd\b|gan|\bw\b|adaptor/i }),
  r('Mobile & Wearables', 'Phone Accessories', { cat: /^Mobile Accessories$/ }),

  r('Computers & Peripherals', 'Webcams & Streaming', { cat: /^Computer (Peripherals|Accessories)$/, name: /webcam|brio|c9\d\d|stream|capture/i }),
  r('Computers & Peripherals', 'Keyboards & Mice', { cat: /^(Computer Peripherals|Computer Accessories|Devices)$/, name: /mouse|mice|keyboard|keypad|combo|presenter|presentation|\bkeys\b|\bm\d{2,3}\b|mx anywhere|receiver|k\d{3}/i }),
  r('Computers & Peripherals', 'Cables & Adaptors', { cat: /^Computer (Peripherals|Accessories)$/, name: /cable|hdmi|vga|adaptor|adapter|splitter|extender|switch|hub|dock|converter|lan/i }),
  r('Computers & Peripherals', 'Computer Accessories', { cat: /^(Computer (Peripherals|Accessories)|Devices)$/ }),

  r('Bags & Laptop Cases', 'Lunch Bags & Bottles', { cat: /^(Bags|Baby & Toddler)$/, name: /lunch|bottle|hydro/i }),
  r('Bags & Laptop Cases', 'Laptop Bags & Backpacks', { cat: /^(Bags|Luggage)$/, name: /laptop|15\.6|14"|13"|notebook|messenger|briefcase/i }),
  r('Luggage & Travel', 'Luggage Sets & Business Trolleys', { cat: /^Luggage$/, name: /trolley/i }),
  r('Bags & Laptop Cases', 'Handbags, Purses & Wallets', { cat: /^Bags$/, name: /handbag|purse|wallet|tote|cross ?body|clutch|sling/i }),
  r('Bags & Laptop Cases', 'Cable Organisers & Pouches', { cat: /^Bags$/, name: /organi[sz]er|pouch|pencil/i }),
  r('Bags & Laptop Cases', 'School & Everyday Backpacks', { cat: /^(Bags|Luggage)$/ }),

  r('Office & School', 'Calculators', { cat: /^Education and learning$/, name: /calculator|casio|sharp|hp 1|texas|nspire|\bel-/i }),
  r('Office & School', 'Stationery', { cat: /^Education and learning$/ }),

  r('Toys & Games', 'STEM & Building Toys', { cat: /^Toys and games$/, name: /build|kit|circuit|volt lab|magnetic|tiles|experiment|robot|science|mags|tank/i }),
  r('Toys & Games', 'Toys & Games', { cat: /^(Toys and games|Kitchen and Home|Rideables)$/ }),
];

// sourceFile is a SQL LIKE pattern on the imported file name: monthly names
// differ ("SMD_Cash_wholesale_September_pricelist_2026_-1.xlsx"), and other
// SMD lists carry the same brands.
export const SMD_LISTS = {
  infant: { label: 'SMD Infant Essential', sourceFile: '%infant%', rules: INFANT_RULES },
  cash: { label: 'SMD Cash Wholesale', sourceFile: '%cash%wholesale%', rules: CASH_RULES },
};
