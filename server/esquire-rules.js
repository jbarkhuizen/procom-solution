// Category rules for Esquire's API feed, used by the auto-list (smd-autolist.js).
//
// Same rule shape as smd-rules.js: `cat` tests Esquire's category column,
// `name` the product name; first match wins, so ORDER MATTERS. Esquire has
// ~680 fine-grained categories ("Cable: HDMI", "CCTV (Dome Camera)"), so most
// rules match on the category alone.
//
// Agreed range (2026-09-29): IT and electronics. Old phone covers, candles,
// balloons, licensed character goods and stationery are never imported.
// Home & kitchen, appliances and personal care were added on the same day.
//
// Parents are matched by name to the live category tree -- keep them spelled
// exactly as in Admin -> Categories, or a duplicate gets created.

const r = (parent, sub, test = {}, extra = {}) => ({ parent, sub, ...test, ...extra });
const skip = (reason, test) => ({ skip: reason, ...test });

const RULES = [
  // --- tech items whose Esquire category looks like a skipped group below
  r('Computers & Peripherals', 'Computer Accessories', { cat: /^multi-function stylus pen$/i }),
  r('Computers & Peripherals', 'Keyboards & Mice', { cat: /^wrist support$/i }),
  r('Computers & Peripherals', 'Ink & Toner', { cat: /^(ink|toner|photo paper|printer ribbons)/i }),
  r('Power & Electrical', 'Tools & Test Equipment', { cat: /^glue gun$/i }),
  r('Bags & Laptop Cases', 'School & Everyday Backpacks', { cat: /^(student backpacks|book bags)$/i }),
  r('Office & School', 'Office Equipment', { cat: /^(laminat|telephone|office equipment)/i }),

  // --- never listed (agreed)
  skip('No Esquire category', { cat: /^\s*$/ }),
  skip('Old phone, iPad and iPod covers', { cat: /^(iphone|samsung (s\d|galaxy note|tab)|blackberry|google nexus|ipod|various phone covers|cell phone case|apple ipad)/i }),
  skip('Candles, balloons and party', { cat: /candle|balloon|scented|reed diffuser|fragrance|room spray/i }),
  skip('Licensed characters and toys', { cat: /^(disney|fifa|tweety|toys|toy baskets|kids puzzles|fidget|clays|abacus|kids swimming|gadgets and gifts)/i }),
  skip('Stationery and art', {
    cat: /(\bbooks?\b|pens$|pencil|folder|files|file dividers|eraser|sharpener|ruler|crayon|colours|paint|pastel|glue|adhesive|stapler|staples|punches|clip boards|clips - paper|drawing|highlighter|marker|chalk|white ?board|examination|writing pack|maths sets|dictionar|labels|pen caddys|desk cubes|desk organisers|magazine holders|planning boards|scissors|tape - clear|^paper a4|pins$|educational board|college and exercise|office supplies|plastic bags)/i,
  }),
  skip('Old media and legacy parts', { cat: /^(disks:|media \(cd|cd \/ dvd cases|cd\/dvd wallet|storage boxes\/disk boxes|cable: (ide|scsi)|controller \(firewire\)|wireless adaptors - pcmcia|modem \(adsl\))/i }),

  // --- Home, kitchen, appliances, personal care (owner: list them, 2026-09-29).
  // Existing live sub-categories where one fits.
  r('Home & Kitchen', 'Large Appliances', { cat: /^(fridges|chest freezers|washing machines|clothing dryers|airconditioning|water dispensers)/i }, { quote: true }),
  r('Home & Kitchen', 'Kitchen Appliances', { cat: /air fryer|kettle|toaster|sandwich|blender|juicer|food (mixers|processors)|multi food|microwave|coffee (makers|grinders)|milk frother|waffle|grills|deep fryer|frying pan|pressure cooker|induction|ice cream|beverage carbonator|biltong|urns|can opener|vacuum sealer|bag sealer|chafing|gas stoves|gas accessories/i }),
  r('Home & Kitchen', 'Heating & Cooling', { cat: /^(fans|heaters|humidifiers|air purifiers|foot warmers|heatpad|electric blankets|hot water bottles)/i }),
  r('Home & Kitchen', 'Cookware & Pans', { cat: /pots & pans|cutlery|knife sets/i }),
  r('Home & Kitchen', 'Food Storage & Drinkware', { cat: /water jugs|vacuum flask|water bottles|coffee mugs|breakfast pack/i }),
  r('Home & Kitchen', 'Utensils & Gadgets', { cat: /utensil|kitchen scale|bread bins|dish racks|salt & pepper|aprons/i }),
  r('Home & Kitchen', 'Irons & Floor Care', { cat: /steam iron|ironing|garment steamer|vacuum cleaner|carpet|floor|pressure washer|mops/i }),
  r('Home & Kitchen', 'Cleaning', { cat: /clean|wipes|microfibre|lint|waste bins|pest control/i }),
  r('Home & Kitchen', 'Braai, Camping & Garden', { cat: /braai|camping|hosepipe|grass trimmer|^rope$|^bike|outdoor accessories/i }),
  r('Furniture', 'Tables', { cat: /^tables & chairs/i }),
  r('Mobile & Wearables', 'Car Accessories', { cat: /^booster cables/i }),
  r('Baby & Toddler', 'Bath & Skin Care', { cat: /^baby bathing/i }),
  r('Baby & Toddler', 'Nappy & Changing Bags', { cat: /^baby maternity handbags/i }),
  r('Health & Beauty', 'Hair Care', { cat: /\bhair/i }),
  r('Health & Beauty', 'Health & Protection', { cat: /thermometer|oximeter|oxygen|health patches|compression|ankle support|knee|elbow|waist belt|sanitizer|gloves|protective/i }),
  r('Health & Beauty', 'Personal Care & Wellness', { cat: /shaver|clipper|cosmetic|facial|massager|nail clippers/i }),
  r('Home & Kitchen', 'Home & Living', { cat: /bathroom|shoe rack|door mats|pillows|washing lines|table accessories|chair bags|clocks|luggage scale|home safe|padlock|latches|filtration|liquid dispensers|utility lighters/i }),

  // --- Computers & Peripherals
  r('Computers & Peripherals', 'Laptops & Tablets', { cat: /notebooks?$|^pcs: tablet pc$/i }, { markup: 10 }),
  r('Computers & Peripherals', 'Desktop PCs', { cat: /^(desktop systems|pc workstations)/i }),
  r('Computers & Peripherals', 'Laptop & Monitor Stands', { cat: /^(monitor brackets|notebook stand)/i }),
  r('Computers & Peripherals', 'Monitors', { cat: /monitor/i }),
  r('Computers & Peripherals', 'Storage & Memory', { cat: /^(hard disk|ssd|memory \((usb|sd|microsd)|otg \(card reader|usb \(card reader|storage \(networked|network attached storage)/i }),
  r('Computers & Peripherals', 'PC Components', { cat: /^(cpu|motherboard|memory \((desktop|mobile)|graphics cards|power supply units|computer case|vga card cooling|pc fan|sound cards|controller|network interface|serial & parallel i\/o|optical drives)/i }),
  r('Computers & Peripherals', 'Printers & Scanners', { cat: /^(printers?\b|document scanners|hand held scanners)/i }),
  r('Computers & Peripherals', 'Software', { cat: /^software/i }),
  r('Computers & Peripherals', 'Webcams & Streaming', { cat: /^web camera/i }),
  r('Computers & Peripherals', 'Headsets & Audio', { cat: /^(headphones and microphones|multimedia\s+speakers)/i }),
  r('Computers & Peripherals', 'Keyboards & Mice', { cat: /^(?!gaming).*(keyboard|mouse|input device)/i }),
  r('Computers & Peripherals', 'Cables & Adaptors', { cat: /^(cable:|hdmi|display port|vga|kvm|video splitter|usb \(hubs|usb ethernet|usb otg|usb mini|parallel\/serial|molex|networking \(kvm)/i }),
  r('Computers & Peripherals', 'Computer Accessories', { cat: /^(notebook (accessories|power|batteries)|laptop batteries|usb (gadgets|\(accessories)|cable (management|clips|ties|accessories)|pcs: (tablet|portable))/i }),

  // --- Networking
  r('Networking', 'Security Cameras', { cat: /^(cctv|ip (camera|dome)|network (cameras|video recorders))/i }),
  r('Networking', 'Routers & Mesh', { cat: /router|^modems/i }),
  r('Networking', 'Switches', { cat: /^(ethernet switches|networking \(switch)/i }),
  r('Networking', 'Business Switches & Access Points', { cat: /^(access point|power over ethernet)/i }),
  r('Networking', 'Wi-Fi Extenders & Adapters', { cat: /^(range extenders|wireless (adaptors|antennas)|networking ?\((wireless|powerline)|bluetooth adaptors)/i }),
  r('Networking', 'Server Cabinets & Racks', { cat: /^server/i }, { quote: true }),
  r('Networking', 'Networking Accessories', { cat: /^(networking|patch cable|network wire|modem \(accessories)/i }),

  // --- TV & Video
  r('TV & Video', 'Televisions', { cat: /^televisions-? ?(smart|android|standard)/i }, { quote: true }),
  r('TV & Video', 'TV Wall Mounts & Stands', { cat: /^(television brackets|tv stands|projector brackets)/i }),
  r('TV & Video', 'Projectors & Screens', { cat: /^projector/i }),
  r('TV & Video', 'TV Cables & Accessories', { cat: /^(televisions- accessories|remote control|multimedia tv|rca adaptors)/i }),

  // --- Gaming
  r('Gaming', 'Consoles & Games', { cat: /^gaming console( sony|-games)/i }),
  r('Gaming', 'Controllers & Racing', { cat: /^(gaming console-controllers|joysticks)/i }),
  r('Gaming', 'Gaming Headsets', { cat: /^(gaming (headsets|earphones)|gaming console-headsets)/i }),
  r('Gaming', 'Gaming Mice & Keyboards', { cat: /^gaming (keyboards|mice|combo)/i }),
  r('Gaming', 'Mouse Pads & Accessories', { cat: /^gaming mouse pads/i }),
  r('Gaming', 'Gaming Accessories', { cat: /^(gaming|vr glasses)/i }),

  // --- Audio
  r('Audio', 'Soundbars & Hi-Fi', { cat: /soundbars|hi-fi|home theater/i }),
  r('Audio', 'Speakers', { cat: /speakers$/i }),
  r('Audio', 'Earphones & Earbuds', { cat: /earphones|earplugs/i }),
  r('Audio', 'Headphones', { cat: /^(wireless headsets|bluetooth headset)/i }),
  r('Audio', 'Microphones & Karaoke', { cat: /^professional microphones/i }),
  r('Audio', 'Audio Accessories', { cat: /^(mp3|voice recorder|car signal)/i }),

  // --- Mobile & Wearables
  r('Mobile & Wearables', 'Phones', { cat: /smart ?phones/i }, { markup: 10 }),
  r('Mobile & Wearables', 'Power Banks', { cat: /^power banks/i }),
  r('Mobile & Wearables', 'Smartwatches', { cat: /^smart watch/i }),
  r('Mobile & Wearables', 'Chargers & Cables', { cat: /sync (&|and) charge|chargers|charger kit|^usb charger/i }),
  r('Mobile & Wearables', 'Car Accessories', { cat: /^(bluetooth car kits|car accessories|car air)/i }),
  r('Mobile & Wearables', 'Phone Accessories', { cat: /^(mobile phone|various phone accessories|selfie|bluetooth gadgets|keyrings)/i }),

  // --- Power & Electrical
  r('Power & Electrical', 'Solar & Inverters', { cat: /inverter|solar (charge|panel|power)|portable power stations|lithium iron|gel agm/i }),
  r('Power & Electrical', 'UPS & Backup Power', { cat: /^power (ups|\(ups|distribution)/i }),
  r('Power & Electrical', 'Multiplugs & Surge Protection', { cat: /^(multiplugs|surge protectors|power \(surge)/i }),
  r('Power & Electrical', 'Adaptors & Extension Leads', { cat: /^power \(adapter/i }),
  r('Power & Electrical', 'Switches, Sockets & Wiring', { cat: /switch socket|^(flush|surface) switches|isolator|cover plate|plug tops|insulation tape|door chimes/i }),
  r('Power & Electrical', 'Batteries', { cat: /batter(y|ies)/i }),
  r('Power & Electrical', 'Tools & Test Equipment', { cat: /toolkits|tool kit|screw drivers|pliers|ratchet|metal cutter|silicone|tape measures|sponge dampeners/i }),

  // --- Smart Home & Lighting
  r('Smart Home & Lighting', 'Light Bulbs', { cat: /^led (bulbs|tube)/i }),
  r('Smart Home & Lighting', 'Outdoor & Flood Lights', { cat: /^(led (flood|bulkhead)|solar lights)/i }),
  r('Smart Home & Lighting', 'Lamps & Indoor Lighting', { cat: /^(led (lamps|lighting|lights|torch)|rechargeable led|solar (rechargeable|lamps))/i }),
  r('Smart Home & Lighting', 'Smart Home', { cat: /^(smart home|security and alarm|wireless intercom|digital photo frame)/i }),

  // --- Cameras, office, bags
  r('Cameras & Photography', 'Digital Cameras', { cat: /^digital camera$/i }),
  r('Cameras & Photography', 'Camera Accessories', { cat: /^digital camera/i }),
  r('Office & School', 'Calculators', { cat: /calculators/i }),
  r('Office & School', 'Point of Sale', { cat: /^(pos|point of sale)/i }),
  r('Bags & Laptop Cases', 'Laptop Bags & Backpacks', { cat: /^(notebook (backpacks|bags|sleeve|trolley)|carry cases)/i }),
];

// Too big for the default 1 kg courier bracket: projector screens, solar
// panels, inverters, big batteries, power stations, large UPSs, 24"+ monitors,
// microwaves, pressure washers, oil heaters.
// (Televisions and server cabinets are quoted as a whole category above.)
const HEAVY = /^(?!.*(fuse|cable|connector|bracket|switch\b|mount|flood|lamp|light|lantern|charger)).*(projector screen|microwave|pressure washer|oil (filled )?heater|solar panel|\binverter\b|powerboard|\d{2,3}\s*ah\b|power station|\bups\b.*\d\s*(k?va)|\b(2[4-9]|3\d|4\d)(\.\d)?\s*("|”|-inch| inch|in\b).*monitor|monitor.*\b(2[4-9]|3\d|4\d)(\.\d)?\s*("|”|-inch| inch))/i;

export const ESQUIRE_LIST = {
  label: 'Esquire (API feed)',
  // The API sync saves every run under this file name (see esquire.js).
  sourceFile: 'esquire-api.json',
  rules: RULES,
  heavy: HEAVY,
};
