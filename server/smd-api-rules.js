// Category rules for SMD products that arrive through SMD's API (smd-api.js)
// and are not in the shop yet (Warehouse feed, file "smd-api.json"). Same
// rule shape as smd-rules.js / esquire-rules.js: `cat` tests SMD's category
// PATH ("Devices/Storage/SSD"), `name` the product name; first match wins.
//
// Placement follows the earlier SMD pricelist decisions (27-28 Sept 2026):
// Smart Home stays under Smart Home & Lighting, Toys & Games and Stationery
// are listed, Creality items go to 3D Printing. SMD delivers everything for
// its flat fee, so no delivery-quote flags are needed here.
//
// Parents and subs are matched by name to the live tree -- spell them exactly.

const r = (parent, sub, test = {}, extra = {}) => ({ parent, sub, ...test, ...extra });
const skip = (reason, test) => ({ skip: reason, ...test });

const RULES = [
  // --- never listed
  skip('Display stand, not for sale', { cat: /^Display Unit/ }),
  skip('Perfume and sunglasses (not our range)', { cat: /^Fashion and beauty\/(Perfumes|Sunglasses)/ }),
  skip('Everfurn Theo table boxes (owner: never list)', { name: /theo dining table/i }),

  // --- Audio
  r('Computers & Peripherals', 'Headsets & Audio', { cat: /^Audio\/(Headsets|Wired Headsets)/ }),
  r('Computers & Peripherals', 'Headsets & Audio', { cat: /^Audio\/Wired Headphones$/ }),
  r('Audio', 'Earphones & Earbuds', { cat: /^Audio\/(Bluetooth|Wired) Earphones/ }),
  r('Audio', 'Headphones', { cat: /^Audio\/(Bluetooth|Wired) Headphones/ }),
  r('Audio', 'Microphones & Karaoke', { cat: /^Audio\/(Microphones|Bluetooth Speakers\/Portable Karaoke)/ }),
  r('Audio', 'Soundbars & Hi-Fi', { cat: /^Audio\/(Bluetooth Speakers\/(Hifi|Powered Soundbars)|Wired Speakers)/ }),
  r('Audio', 'Speakers', { cat: /^Audio\/Bluetooth Speakers/ }),
  r('Audio', 'Audio Accessories', { cat: /^Audio/ }),

  // --- Baby & Toddler
  r('Baby & Toddler', 'Dummies & Teethers', { cat: /^Baby & Toddler\/Accessories/ }),
  r('Baby & Toddler', 'Bottles & Teats', { cat: /^Baby & Toddler\/Bottles/ }),
  r('Baby & Toddler', 'Maternity & Breastfeeding', { cat: /^Baby & Toddler\/Breast/ }),
  r('Baby & Toddler', 'Wipes', { cat: /^Baby & Toddler\/Wet Wipes/ }),
  r('Toys & Games', 'Games & Novelties', { cat: /^Baby & Toddler\/Toys/ }),
  r('Baby & Toddler', 'Baby Gear & Travel', { cat: /^Bags\/Baby Accessories/ }),
  r('Baby & Toddler', 'Nappy & Changing Bags', { cat: /^Bags\/Baby Bags/ }),

  // --- Bags & luggage
  r('Bags & Laptop Cases', 'Handbags, Purses & Wallets', { cat: /^Bags\/Device Bags\/Sling/ }),
  r('Bags & Laptop Cases', 'Laptop Bags & Backpacks', { cat: /^Bags\/Device Bags/ }),
  r('Bags & Laptop Cases', 'Lunch Bags & Bottles', { cat: /^Bags\/Lunch/ }),
  r('Luggage & Travel', 'Travel Bags & Accessories', { cat: /^Bags\/Duffle/ }),
  r('Bags & Laptop Cases', 'School & Everyday Backpacks', { cat: /^Bags/ }),
  r('Luggage & Travel', 'Luggage Sets & Business Trolleys', { cat: /^Luggage\/Trollies\/Business/ }),
  r('Luggage & Travel', 'Luggage Sets & Business Trolleys', { cat: /^Luggage/, name: /\b\d\s*pc\b|\bset\b/i }),
  r('Luggage & Travel', 'Suitcases', { cat: /^Luggage/ }),

  // --- Computers & peripherals
  r('Gaming', 'Gaming Mice & Keyboards', { cat: /^Computer Peripherals\/Gaming/ }),
  r('Networking', 'Wi-Fi Extenders & Adapters', { cat: /^Computer (Peripherals|Accessories)\/Cables\/Networking/, name: /wi-?fi|wireless|dongle/i }),
  r('Computers & Peripherals', 'Headsets & Audio', { cat: /^Computer Peripherals\/Headsets/ }),
  r('Computers & Peripherals', 'Webcams & Streaming', { cat: /^Computer Peripherals\/(Webcams|Video Conferencing)/ }),
  r('Computers & Peripherals', 'Keyboards & Mice', { cat: /^Computer Peripherals(\/(Keyboards|Mouses|Presenter))?$/ }),
  r('Computers & Peripherals', 'Laptop & Monitor Stands', { cat: /^Computer Accessories$/, name: /stand/i }),
  r('Computers & Peripherals', 'Cables & Adaptors', { cat: /^Computer (Peripherals|Accessories)/ }),

  // --- Devices
  r('3D Printing', 'Laser Engravers', { cat: /^Devices\/3D Printers$/, name: /laser|engraver|falcon/i }),
  r('3D Printing', '3D Printers – FDM', { cat: /^Devices\/3D Printers$/ }),
  r('3D Printing', 'Laser Engraving Materials', { cat: /^Devices\/3D Printers\/Laser/, name: /ink|material|board|sheet|plywood|acrylic|leather|card/i }),
  r('3D Printing', 'Laser Engravers', { cat: /^Devices\/3D Printers\/Laser/ }),
  r('3D Printing', 'Filament – PETG', { cat: /^Devices\/3D Printers\/Filament/, name: /petg/i }),
  r('3D Printing', 'Filament – ABS & ASA', { cat: /^Devices\/3D Printers\/Filament/, name: /\b(abs|asa)\b/i }),
  r('3D Printing', 'Filament – PLA', { cat: /^Devices\/3D Printers\/Filament/, name: /\bpla\b/i }),
  r('3D Printing', 'Filament – TPU & Specialist', { cat: /^Devices\/3D Printers\/Filament/ }),
  r('3D Printing', 'Resin', { cat: /^Devices\/3D Printers\/Resin/ }),
  r('3D Printing', 'Upgrades & Accessories', { cat: /^Devices\/3D Printers/ }),
  r('Computers & Peripherals', 'PC Components', { cat: /^Devices\/(Computer Components|Storage\/SSD)/, name: /cool|fan|ddr|ram\b|memory|desktop|so-?dimm/i }),
  r('Computers & Peripherals', 'Storage & Memory', { cat: /^Devices\/Storage/ }),
  r('Computers & Peripherals', 'PC Components', { cat: /^Devices\/Computer Components/ }),
  r('Computers & Peripherals', 'Desktop PCs', { cat: /^Devices\/Desktops/ }),
  r('Computers & Peripherals', 'Computer Accessories', { cat: /^Devices\/Laptops\/(Accessories|Laptop chargers)/ }),
  r('Computers & Peripherals', 'Laptops & Tablets', { cat: /^Devices\/(Laptops|Tablets)/ }),
  r('Computers & Peripherals', 'Laptops & Tablets', { cat: /^Devices$/, name: /laptop|notebook|chromebook|tablet/i }),
  r('Mobile & Wearables', 'Phones', { cat: /^Devices\/Mobile Phones/ }),
  r('Computers & Peripherals', 'Laptop & Monitor Stands', { cat: /^Devices\/Monitors\/Monitor Mounts/ }),
  r('Computers & Peripherals', 'Monitors', { cat: /^Devices\/Monitors/ }),
  r('Office & School', 'Point of Sale', { cat: /^Devices\/Payment/ }),
  r('Smart Home & Lighting', 'Smart Home', { cat: /^Devices\/Photo Frames/ }),
  r('Computers & Peripherals', 'Printers & Scanners', { cat: /^Devices\/Printers/ }),
  r('TV & Video', 'Projectors & Screens', { cat: /^Devices\/Projectors/ }),
  r('Toys & Games', 'STEM & Building Toys', { cat: /^Devices$/, name: /learning|kids|dinosaur|robot|educational/i }),
  // "Devices" with no sub-category: sorted by what the name says.
  r('Mobile & Wearables', 'Phones', { cat: /^Devices$/, name: /iphone|galaxy|smartphone|cellphone/i }),
  r('Computers & Peripherals', 'Storage & Memory', { cat: /^Devices$/, name: /\b(micro ?sd|msd|sd card|flash|usb|ssd|hdd)\b/i }),
  r('Computers & Peripherals', 'Printers & Scanners', { cat: /^Devices$/, name: /print|scan/i }),
  r('Computers & Peripherals', 'Laptops & Tablets', { cat: /^Devices$/, name: /\d+\s*gb\s*\/\s*\d+\s*gb|win ?1[01]|core i\d|ryzen/i }),

  // --- Office & school
  r('Office & School', 'Calculators', { cat: /^Education and learning\/Calculators/ }),
  r('Office & School', 'Stationery', { cat: /^Education and learning\/Stationery/ }),
  r('Toys & Games', 'Games & Novelties', { cat: /^Education and learning\/Toys/ }),
  r('Computers & Peripherals', 'Software', { cat: /^Software/ }),

  // --- Power & electrical
  r('Power & Electrical', 'Solar & Inverters', { cat: /^Electrical\/(Battery Backup|Invertors)/ }),
  r('Power & Electrical', 'Batteries', { cat: /^Electrical\/Batteries/ }),
  r('Smart Home & Lighting', 'Smart Home', { cat: /^Electrical\/Security/ }),
  r('Power & Electrical', 'Multiplugs & Surge Protection', { cat: /^Electrical(\/(Multiplugs|Surge Protection))?/, name: /surge|multiplug/i }),
  r('Power & Electrical', 'Multiplugs & Surge Protection', { cat: /^Electrical\/(Multiplugs|Surge Protection)/ }),
  r('Power & Electrical', 'Adaptors & Extension Leads', { cat: /^Electrical\/(Adaptors|Extension Leads)/ }),
  r('Power & Electrical', 'Switches, Sockets & Wiring', { cat: /^Electrical\/Accessories/ }),
  r('Power & Electrical', 'Electrical Accessories', { cat: /^Electrical/ }),

  // --- Furniture
  r('Gaming', 'Gaming Chairs & Desks', { cat: /^Furniture\/(Chairs\/Gaming|Desks\/Gaming)/ }),
  r('Furniture', 'Desks & Office Chairs', { cat: /^Furniture\/(Chairs\/Office|Desks|Caster)/ }),
  r('Furniture', 'Seating & Living', { cat: /^Furniture\/(Chairs|Patio)/ }),
  r('Furniture', 'Tables', { cat: /^Furniture\/(Tables|Side Tables)/ }),
  r('Furniture', 'Shelving & Storage', { cat: /^Furniture\/(Shelves|TV Stands)/ }),

  // --- Gaming
  r('Gaming', 'Controllers & Racing', { cat: /^Gaming\/(Controllers|Flight|Racing)/ }),
  r('Gaming', 'Controllers & Racing', { cat: /^Gaming$/, name: /wheel|pedal|shifter|controller|throttle|joystick|kit/i }),
  r('Gaming', 'Gaming Mice & Keyboards', { cat: /^Gaming\/Gaming (Keyboards|Mouses)/ }),
  r('Gaming', 'Handheld & Retro Consoles', { cat: /^Gaming\/Handheld/ }),
  r('Gaming', 'Gaming Accessories', { cat: /^Gaming\/Headsets\/Stands/ }),
  r('Gaming', 'Gaming Headsets', { cat: /^Gaming\/Headsets/ }),
  r('Gaming', 'Gaming Accessories', { cat: /^Gaming/ }),

  // --- Health & beauty
  r('Home & Kitchen', 'Heating & Cooling', { cat: /^Health and wellness\/Humidifiers/ }),
  r('Health & Beauty', 'Hair Care', { cat: /^Health and wellness\/Personal care/, name: /hair|dryer|straighten|curl|clipper|trimmer|groom|shaver|brush/i }),
  r('Health & Beauty', 'Personal Care & Wellness', { cat: /^(Health and wellness|Fashion and beauty)/ }),
  r('Health & Beauty', 'Fitness & Sport', { cat: /^Sports and fitness/ }),

  // --- Home & kitchen
  r('Home & Kitchen', 'Kitchen Appliances', { cat: /^Kitchen and Home\/Kitchen Appliances/ }),
  r('Home & Kitchen', 'Cookware & Pans', { cat: /^Kitchen and Home\/Indoor Cooking/ }),
  r('Home & Kitchen', 'Food Storage & Drinkware', { cat: /^Kitchen and Home\/(Storage|Glassware|Hydration|Dinnerware)/ }),
  r('Home & Kitchen', 'Utensils & Gadgets', { cat: /^Kitchen and Home\/(Baking|Utensils|Knives|Kitchen Accessories)/ }),
  r('Home & Kitchen', 'Irons & Floor Care', { cat: /^Kitchen and Home\/(Cleaning appliances|Garment Care|Cleaning\/Laundry)/ }),
  r('Home & Kitchen', 'Cleaning', { cat: /^Kitchen and Home\/Cleaning/ }),
  r('Home & Kitchen', 'Heating & Cooling', { cat: /^Kitchen and Home\/(Cooling|Home Appliances\/(Heating|Bed))/ }),
  r('Home & Kitchen', 'Home & Living', { cat: /^Kitchen and Home/ }),

  // --- Lighting
  r('Smart Home & Lighting', 'Light Bulbs', { cat: /^Lighting\/Bulbs/ }),
  r('Smart Home & Lighting', 'Outdoor & Flood Lights', { cat: /^Lighting\/Motion Sensor/ }),
  r('Smart Home & Lighting', 'Lamps & Indoor Lighting', { cat: /^Lighting/ }),

  // --- Mobile & wearables
  r('Mobile & Wearables', 'Power Banks', { cat: /^Mobile Accessories\/Charging\/Power Banks/ }),
  r('Mobile & Wearables', 'Car Accessories', { cat: /^Mobile Accessories\/Charging\/Car/ }),
  r('Mobile & Wearables', 'Chargers & Cables', { cat: /^Mobile Accessories\/(Cables|Charging)/ }),
  r('Mobile & Wearables', 'Car Accessories', { cat: /^Mobile Accessories\/Accessories$/, name: /\bcar\b|vent|dash/i }),
  r('Mobile & Wearables', 'Phone Accessories', { cat: /^Mobile Accessories/ }),
  r('Mobile & Wearables', 'Smartwatches', { cat: /^Wearables/ }),

  // --- Networking
  r('Networking', 'Security Cameras', { cat: /^Networking\/Security/ }),
  r('Networking', 'Business Switches & Access Points', { cat: /^Networking/, name: /\beap\d|access point|omada/i }),
  r('Networking', 'Wi-Fi Extenders & Adapters', { cat: /^Networking\/(Adaptors|Range Extenders)/ }),
  r('Networking', 'Wi-Fi Extenders & Adapters', { cat: /^Networking/, name: /range extender|dongle/i }),
  r('Networking', 'Switches', { cat: /^Networking\/Network Switches/ }),
  r('Networking', 'Routers & Mesh', { cat: /^Networking/ }),

  // --- Photography
  r('Cameras & Photography', 'Dash Cams', { cat: /^Photography\/Cameras\/Dash/ }),
  r('Cameras & Photography', 'Digital Cameras', { cat: /^Photography\/Cameras$/ }),
  r('Cameras & Photography', '360 & Action Cameras', { cat: /^Photography\/Cameras\/Action/ }),
  r('Cameras & Photography', '360 & Action Cameras', { cat: /^Photography$/, name: /camera|bundle|\bx[3-5]\b|ace pro|go ?3|\bkit\b/i }),
  r('Cameras & Photography', 'Camera Accessories', { cat: /^Photography/ }),

  // --- Smart home, TV, toys
  r('Smart Home & Lighting', 'Smart Home', { cat: /^Smart Home/ }),
  r('TV & Video', 'TV Cables & Accessories', { cat: /^Televisions\/Accessories/ }),
  r('TV & Video', 'TV Wall Mounts & Stands', { cat: /^Televisions\/TV Mounts/ }),
  r('TV & Video', 'Televisions', { cat: /^Televisions/ }),
  r('Toys & Games', 'STEM & Building Toys', { cat: /^Toys and games\/Educational/ }),
  r('Toys & Games', 'Outdoor & Bubble Toys', { cat: /^Toys and games\/Outdoor/ }),
  r('Toys & Games', 'Games & Novelties', { cat: /^Toys and games/ }),

  // --- last resort, by name (any SMD category)
  r('Computers & Peripherals', 'Monitors', { name: /^(?!.*(mount|arm|stand|bracket)).*monitor/i }),
  r('Smart Home & Lighting', 'Smart Home', { name: /weather station/i }),
];

export const SMD_API_LIST = {
  label: 'SMD (API, new products)',
  sourceFile: 'smd-api.json',
  rules: RULES,
};
