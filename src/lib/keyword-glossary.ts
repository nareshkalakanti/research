/**
 * Hover tips for theme-scan highlights in About text.
 * Keys are lowercase. Prefer specific multi-word phrases; acronyms next.
 * Theme-derived defs (from themes.json / theme_keywords.json) win over static DEFS.
 */

import themeKeywordDefs from "./theme-keyword-defs.json";

const THEME_DEFS = themeKeywordDefs as Record<string, string>;

const DEFS: Record<string, string> = {
  // —— Power / conductors / copper ——
  acsr: "Aluminium Conductor Steel Reinforced — overhead line conductor (Al strands over steel core).",
  aaac: "All Aluminium Alloy Conductor — overhead conductor without a steel core.",
  opgw: "Optical Ground Wire — tower earth wire that also carries fibre optics.",
  ctc: "Continuously Transposed Conductor — multi-strand copper for large transformer windings (cuts eddy losses).",
  "continuously transposed":
    "Continuously Transposed Conductor (CTC) — multi-strand copper for power transformer windings.",
  "transposed + conductor":
    "Transposed conductor (CTC family) — strands swapped along length to cut winding losses.",
  "transformer winding":
    "Copper/aluminium windings inside a transformer that transfer power between voltage levels.",
  "paper insulated":
    "Conductor wrapped in insulating paper — classic transformer winding construction.",
  picc: "Paper Insulated Copper Conductor — copper wrapped in insulating paper for transformers.",
  busbar:
    "Rigid Cu/Al bar that distributes high current in panels, switchboards, or battery packs.",
  "bus bar":
    "Rigid Cu/Al bar that distributes high current in panels, switchboards, or battery packs.",
  "bus bars":
    "Rigid Cu/Al bars that distribute high current in panels, switchboards, or battery packs.",
  busbars:
    "Rigid Cu/Al bars that distribute high current in panels, switchboards, or battery packs.",
  "bus duct":
    "Metal enclosure carrying busbars for high-current power distribution.",
  busduct:
    "Metal enclosure carrying busbars for high-current power distribution.",
  "copper busbar": "Copper busbar — high-conductivity bar for power distribution.",
  "copper + busbar": "Copper busbar — high-conductivity bar for power distribution.",
  "magnet wire":
    "Insulated copper wire wound into motor/transformer coils (enamelled / winding wire).",
  "enamelled wire":
    "Copper wire coated with thin insulating enamel for motor and transformer windings.",
  "winding wire":
    "Insulated copper wire used to wind coils in motors, transformers, and inductors.",
  "copper foils":
    "Thin rolled copper sheet — PCBs, transformers, battery current collectors.",
  "copper foil":
    "Thin rolled copper sheet — PCBs, transformers, battery current collectors.",
  "copper rod": "Cast/drawn copper rod — feedstock for wire, strip, and busbar.",
  "copper strip": "Flat copper strip — used for busbars, transformers, and connectors.",
  "copper wire": "Drawn copper wire for electrical conductors and windings.",
  "copper tube": "Copper tubing — HVAC, heat exchangers, and some electrical uses.",
  "copper tubes": "Copper tubing — HVAC, heat exchangers, and some electrical uses.",
  "copper + scrap": "Scrap copper feedstock for recycling into rod/wire/alloy.",
  "copper + recycling": "Recycling scrap copper back into usable metal products.",
  "copper + alloys": "Copper mixed with other metals (brass, bronze, etc.) for strength/corrosion resistance.",
  "copper + cathode": "Refined copper cathode — primary pure copper traded/used as feedstock.",
  "copper + conductor": "Electrical conductor made primarily of copper.",
  "silver plated + copper":
    "Copper with a silver plating — better contact conductivity and corrosion resistance.",
  "silver plated":
    "Metal plated with silver — improves electrical contact and corrosion resistance.",
  etp: "Electrolytic Tough Pitch copper — standard high-conductivity grade (~99.9% Cu).",
  "etp + copper":
    "Electrolytic Tough Pitch copper — standard high-conductivity grade (~99.9% Cu).",
  "oxygen free + copper":
    "Oxygen-free copper (OFC) — ultra-low oxygen for high conductivity / purity uses.",
  "oxygen free":
    "Oxygen-free copper (OFC) — ultra-low oxygen for high conductivity / purity uses.",
  brass: "Copper–zinc alloy — machining, fittings, electrical hardware.",
  bronze: "Copper–tin (or other) alloy — bearings, bushings, marine hardware.",
  crgo: "Cold Rolled Grain Oriented steel — electrical steel for transformer cores.",
  "amorphous core":
    "Transformer core from amorphous metal — lower no-load losses than CRGO.",
  "amorphous + core":
    "Transformer core from amorphous metal — lower no-load losses than CRGO.",
  amorphous: "Amorphous metal — glassy alloy used in high-efficiency transformer cores.",
  crca: "Cold Rolled Close Annealed steel — precision cold-rolled steel sheet.",
  "cold rolled": "Steel rolled at room temperature for tighter thickness and finish.",
  "cold rolled + steel":
    "Steel rolled cold for tighter gauge tolerance and better surface finish.",
  "magnetic core": "Ferromagnetic core that concentrates magnetic flux in transformers/motors.",
  lamination: "Thin steel sheets stacked to form a transformer/motor core (cuts eddy currents).",
  stator: "Stationary part of a motor/generator that holds the windings.",
  "rotor + core": "Rotating magnetic core inside a motor or generator.",
  rotor: "Rotating part of a motor/generator.",
  ferrite: "Ceramic magnetic material used in inductors, transformers, EMI cores.",
  bobbin: "Former/spool that holds a coil winding.",
  "thermostatic bimetals":
    "Bonded dual-metal strips that bend with temperature (different expansion rates) — used as mechanical thermostats in heaters, breakers, thermal protectors.",
  "thermostatic bimetal":
    "Bonded dual-metal strip that bends with temperature (different expansion rates) — used as a mechanical thermostat in heaters, breakers, thermal protectors.",
  bimetal:
    "Two metals bonded together; in thermostats, different expansion rates make the strip bend with heat.",
  bimetals:
    "Two metals bonded together; in thermostats, different expansion rates make the strip bend with heat.",
  xlpe: "Cross-Linked Polyethylene — common insulation for power cables.",
  "transformer oil":
    "Insulating/cooling oil used inside oil-filled power transformers.",
  transformer:
    "Device that changes AC voltage levels using magnetic coupling between windings.",
  "power transformer":
    "Large transformer for transmission/sub-transmission voltage levels.",
  "distribution transformer":
    "Transformer that steps voltage down for local distribution / end users.",
  "dry type transformer":
    "Transformer cooled by air (no oil) — often used indoors / fire-sensitive sites.",
  "cast resin transformer":
    "Dry-type transformer with windings encapsulated in epoxy resin.",
  ehv: "Extra High Voltage — typically ≥220 kV transmission class.",
  "ehv cable": "Extra-high-voltage power cable (≥220 kV class).",
  "hv + cable": "High-voltage power cable.",
  "lt + cable": "Low-tension (low-voltage) power cable.",
  "ht + panel": "High-tension (high-voltage) electrical switchboard/panel.",
  "lt + panel": "Low-tension (low-voltage) electrical switchboard/panel.",
  hv: "High Voltage — typically tens of kV and above.",
  lt: "Low Tension / low voltage — typically ≤1 kV distribution class.",
  ht: "High Tension — medium/high voltage side of power equipment.",
  hvdc: "High Voltage Direct Current — long-distance or undersea DC transmission.",
  switchgear:
    "Gear that switches, protects, and isolates circuits (breakers, isolators, panels).",
  "switchgear + components":
    "Parts used inside switchgear — contacts, insulation, mechanisms, enclosures.",
  gis: "Gas Insulated Switchgear — compact HV gear insulated with SF₆ (or alternatives).",
  "gas insulated substation":
    "Substation using gas-insulated switchgear for a compact HV footprint.",
  oltc: "On-Load Tap Changer — adjusts transformer ratio while energised.",
  "load tap changer":
    "Tap changer that adjusts transformer voltage ratio (often on-load).",
  "capacitor bank":
    "Bank of power capacitors for reactive power / power-factor correction.",
  "shunt reactor":
    "Reactor that absorbs reactive power on long HV lines / cable systems.",
  substation:
    "Facility that transforms voltage and switches power (transformers, switchgear, busbars).",
  substations:
    "Facilities that transform voltage and switch power (transformers, switchgear, busbars).",
  "circuit breaker":
    "Switch that can interrupt fault current to protect the network.",
  isolator: "Disconnector — isolates equipment for safety (not for breaking load current).",
  "lightning arrester":
    "Surge arrester that dumps lightning/switching overvoltage to earth.",
  insulator: "Non-conducting support that keeps live parts clear of earth/structure.",
  cable: "Insulated electrical conductor for power or control signals.",
  cables: "Insulated electrical conductors for power or control signals.",
  "control cable": "Low-voltage multi-core cable for control and instrumentation.",
  "overhead + conductor": "Bare conductor strung on towers/poles for overhead lines.",
  "aluminium conductor": "Overhead/power conductor made primarily of aluminium.",
  "panel + board": "Electrical switchboard / distribution panel assembly.",
  ups: "Uninterruptible Power Supply — battery-backed power for critical loads.",
  inverter: "Converts DC to AC (solar, UPS, EV, industrial drives).",
  rectifier: "Converts AC to DC.",
  "power + electronics":
    "Circuits that efficiently convert/control electric power (inverters, drives, converters).",
  "power + electronics + manufacturing":
    "Making power-electronics products — inverters, converters, drives, etc.",
  "data center + power":
    "Electrical infrastructure that feeds and backs up data-centre IT load.",
  "liquid cooling":
    "Cooling electronics/servers with circulating liquid instead of air only.",
  "immersion cooling":
    "Cooling IT gear by immersing boards/servers in dielectric fluid.",
  "genset + data center":
    "Diesel/gas generator sets used as backup power for data centres.",

  // —— Capacitors / dielectric ——
  dielectric:
    "Insulating material that stores electric energy in a capacitor field.",
  capacitor: "Passive component that stores energy in an electric field.",
  "capacitor film":
    "Thin polymer film used as the dielectric inside film capacitors.",
  "metallized film":
    "Polymer film with a thin metal coating — electrode + dielectric for capacitors.",
  "metallised film":
    "Polymer film with a thin metal coating — electrode + dielectric for capacitors.",
  "polypropylene + film":
    "PP film — common dielectric material for power/film capacitors.",
  polypropylene: "Common plastic; capacitor-grade film is a key dielectric material.",
  "power capacitor":
    "Capacitor for power systems — PFC, filtering, HV applications.",
  "film capacitor":
    "Capacitor using plastic film as dielectric — power electronics and grids.",
  supercapacitor:
    "Ultra-high capacitance device for short bursts of power (not a battery).",
  "ultra capacitor":
    "Another name for supercapacitor — high power, short-duration energy storage.",
  "capacitor + grade":
    "Material/film certified for use as capacitor dielectric.",

  // —— Energy storage / EV / meters ——
  bess: "Battery Energy Storage System — batteries that store and discharge electricity.",
  "battery energy storage":
    "BESS — batteries that store and discharge electricity for grid or sites.",
  "battery energy storage system":
    "BESS — batteries that store and discharge electricity for grid or sites.",
  "energy storage":
    "Systems that store energy (usually batteries) for later use.",
  "energy storage + system":
    "Complete energy-storage setup — batteries, PCS, controls, balance of plant.",
  "energy storage + systems":
    "Complete energy-storage setups — batteries, PCS, controls, balance of plant.",
  ccs: "Cell Connecting System — interconnects battery cells in a pack (also an EV charge-plug name).",
  "cell connecting system":
    "CCS — busbar/flex assembly linking cells inside a battery pack.",
  "cell connecting systems":
    "CCS — busbar/flex assemblies linking cells inside a battery pack.",
  "ccs + assembly": "Assembled cell-connecting system for battery packs.",
  "ccs + battery": "Cell-connecting hardware used inside a battery pack.",
  "battery + ccs": "Battery pack using a cell connecting system (CCS).",
  "battery + busbar": "Busbars that carry current between cells/modules in a pack.",
  "battery + pack": "Assembled battery pack — cells, interconnects, BMS, enclosure.",
  "battery + components": "Parts used to build batteries/packs (busbars, BMS parts, etc.).",
  "battery + management":
    "Battery Management System (BMS) — monitors/protects cells and pack.",
  battery: "Electrochemical energy store — cells/modules/packs.",
  "smart meter":
    "Digital meter with two-way comms for remote reading and load data.",
  "smart meters":
    "Digital meters with two-way comms for remote reading and load data.",
  "smart metering":
    "Deploying smart meters plus the IT/comms stack that manages them.",
  "smart meter + components": "Parts made for smart electricity meters.",
  "smart meter + manufacturing": "Manufacturing smart electricity meters.",
  "smart meters + manufacturing": "Manufacturing smart electricity meters.",
  ami: "Advanced Metering Infrastructure — meters + network + head-end systems.",
  "advanced metering infrastructure":
    "AMI — smart meters, communications, and utility head-end systems.",
  "ev component": "Component made for electric vehicles.",
  "ev components": "Components made for electric vehicles.",
  "electric vehicle + components": "Parts manufactured for EVs.",
  "electric vehicle": "Vehicle propelled mainly by electric motors and batteries.",
  ev: "Electric vehicle — driven by electric motors and batteries.",
  "ev + electronics": "Power/control electronics used in electric vehicles.",
  "e-axle": "Integrated EV drive unit — motor + gearbox + inverter in one axle package.",
  "charging + connector": "Plug/inlet hardware for EV charging.",

  // —— Electronics / EMS / AI hardware ——
  pcba: "Printed Circuit Board Assembly — PCB populated with components.",
  "pcb assembly": "Mounting components onto a printed circuit board (PCBA).",
  "printed circuit board assembly":
    "PCBA — bare board populated with electronic components.",
  "pcba + assembly": "Building populated circuit-board assemblies.",
  "pcba + assemblies": "Populated circuit-board assemblies.",
  pcb: "Printed Circuit Board — laminated board that interconnects electronics.",
  "printed circuit board":
    "PCB — laminated board that interconnects electronic components.",
  "pcb + fabrication": "Manufacturing bare printed circuit boards.",
  "multilayer + pcb": "PCB with many copper layers for dense routing.",
  multilayer: "Multi-layer PCB construction for denser electronics.",
  smt: "Surface Mount Technology — placing parts on the PCB surface.",
  "surface mount": "SMT — components mounted on the board surface.",
  ems: "Electronics Manufacturing Services — contract build of electronics for OEMs.",
  "electronics manufacturing services":
    "EMS — contract manufacturing of electronic products for brand owners.",
  "ems + provider": "Company that offers electronics manufacturing services.",
  "ems + company": "Company that offers electronics manufacturing services.",
  "ems + services": "Contract electronics manufacturing offerings.",
  "box build":
    "Full product build beyond PCB — enclosure, wiring, test, pack.",
  odm: "Original Design Manufacturer — designs and builds products sold under another brand.",
  oem: "Original Equipment Manufacturer — brand owner specifying/buying parts or products.",
  "oem + electronics": "Electronics supplied to or built for OEM brands.",
  "oem + auto": "Auto parts supplied to vehicle OEMs.",
  osat: "Outsourced Semiconductor Assembly and Test — chip packaging & test houses.",
  hdi: "High Density Interconnect — fine-line PCB with microvias.",
  "hdi + boards": "High-density interconnect PCBs for compact electronics.",
  "electronic assembly": "Assembling electronic components into boards/products.",
  electronics: "Devices and circuits that process electrical signals/power.",
  "industrial + electronics": "Electronics for factory/automation/industrial equipment.",
  "automotive + electronics": "Electronics used in vehicles (ECUs, sensors, power).",
  "consumer electronics + manufacturing":
    "Making consumer electronic products or their assemblies.",
  "telecom + equipment + manufacturing":
    "Making telecom network/equipment hardware.",
  "led + manufacturing": "Manufacturing LED lamps/modules or LED assemblies.",
  led: "Light Emitting Diode — semiconductor light source.",
  "server + manufacturing": "Building server hardware for IT/data centres.",
  "ai + server": "Server designed for AI workloads (GPUs/accelerators, high power/cooling).",
  "gpu + assembly": "Assembling GPU boards/accelerators for AI or graphics.",
  gpu: "Graphics Processing Unit — also the main AI training/inference accelerator.",
  "data center + hardware": "Servers, networking, and IT gear used in data centres.",
  "optical + transceiver":
    "Module that converts electrical signals to optical (fibre) and back.",
  "networking + equipment": "Switches, routers, and related network hardware.",
  ai: "Artificial Intelligence — models/systems that learn patterns and make predictions.",
  hbm: "High Bandwidth Memory — stacked DRAM next to AI accelerators.",
  "high bandwidth memory":
    "HBM — stacked DRAM used with AI GPUs for very high bandwidth.",
  dram: "Dynamic RAM — main working memory in servers and PCs.",
  nand: "NAND flash — non-volatile memory used in SSDs.",
  ssd: "Solid State Drive — flash storage with no spinning disk.",
  dimm: "Dual Inline Memory Module — standard RAM stick form factor.",
  "memory + packaging": "Assembling/packaging semiconductor memory chips.",
  "memory module": "PCB assembly of DRAM chips (e.g. DIMM).",
  "flash + memory": "Non-volatile NAND/NOR flash memory.",
  "storage + controller": "Chip/firmware that manages SSD or storage device.",
  "silicon wafer": "Round silicon disc used as the base for making chips.",
  wafer: "Silicon wafer — base substrate for semiconductor manufacturing.",
  "specialty gas + semiconductor":
    "Ultra-pure gases used in chip fab processes.",
  "specialty gas": "High-purity process gases (often for semis / electronics).",
  photoresist: "Light-sensitive resist used to pattern wafers in lithography.",
  "cmp + slurry":
    "Chemical Mechanical Planarization slurry — polishes wafers flat.",
  slurry: "Abrasive chemical mix used in wafer polishing (CMP).",
  "semiconductor assembly": "Packaging chips after wafer fab (OSAT step).",
  "semiconductor packaging": "Encasing chips and connecting them to boards.",
  "wafer + level + packaging":
    "Packaging chips at wafer scale before dicing (WLP).",
  semiconductor: "Material/device (silicon etc.) that underpins chips and electronics.",

  // —— Precision / industrial ——
  "precision engineering":
    "Tight-tolerance machining/fabrication of critical mechanical parts.",
  "precision components":
    "Parts made to tight dimensional tolerances for critical equipment.",
  "critical components":
    "Parts whose quality/failure strongly affects whole-system reliability.",
  "engineered components":
    "Designed/manufactured parts for a specific engineering function.",
  "precision + manufacturing":
    "Manufacturing to tight tolerances — CNC, tooling, process control.",
  "proprietary + manufacturing":
    "In-house process/know-how that is hard for rivals to copy.",
  "proprietary + technology":
    "Owned technology/IP that supports product differentiation.",
  "high + entry + barriers":
    "Industry hard to enter — capex, certification, know-how, customer lock-in.",
  "niche + segment": "Focused specialty market rather than a broad mass market.",
  "niche + engineering": "Specialist engineering for a narrow application set.",
  "integrated + electrical + assembly":
    "Assembled electrical modules combining multiple components.",
  "integrated + electronic + assembly":
    "Assembled electronic modules combining boards and interconnects.",
  "value added + components":
    "Components with extra processing/features beyond basic commodity parts.",
  "value added + products":
    "Products with extra processing/features beyond basic commodities.",
  "sub assembly": "Partially assembled module that later goes into a larger product.",
  "sub-assemblies": "Modules assembled for later integration into a finished product.",
  "metal + components": "Fabricated metal parts for industrial/OEM use.",
  "stamped + components": "Parts formed by press stamping sheet metal.",
  "cnc + components": "Parts machined on CNC equipment to tight tolerances.",
  cnc: "Computer Numerical Control — automated precision machining.",
  "turned + components": "Parts made on lathes (turned from bar/rod).",
  "deep drawn + components":
    "Sheet-metal parts formed by deep drawing into cups/complex shapes.",
  "industrial automation":
    "Machines and controls that automate factory processes.",
  "automation + components":
    "Parts used in automation systems — sensors, actuators, frames, etc.",
  automation: "Using machines/controls to run processes with less manual work.",
  manufacturing: "Making physical products at industrial scale.",
  assembly: "Joining parts into a higher-level product or module.",
  assemblies: "Joined modules/products built from multiple parts.",

  // —— Foundry ——
  foundry: "Plant that melts metal and pours it into moulds to make castings.",
  foundries: "Plants that melt metal and pour castings.",
  fluxes: "Chemicals that clean/protect molten metal during casting/welding.",
  risers: "Feeders on a casting mould that supply metal as the casting shrinks.",
  "feeding systems": "Foundry systems that feed molten metal into the casting as it solidifies.",
  inoculants: "Additives that control cast-iron microstructure during pouring.",
  exothermic: "Heat-releasing (e.g. exothermic sleeves that keep riser metal molten).",
  "core binders": "Binders that hold sand cores in shape for casting cavities.",
  "metallurgical + consumables":
    "Consumable materials used in metal casting/steelmaking processes.",
  "casting + consumables":
    "Consumables used when pouring and finishing metal castings.",
  refractory: "Heat-resistant material lining furnaces and molten-metal vessels.",
  refractories: "Heat-resistant materials lining furnaces and molten-metal vessels.",
  crucibles: "Heat-resistant vessels that hold molten metal.",
  "mould + coatings": "Coatings on moulds/cores to improve casting surface quality.",
  "mold coatings": "Coatings on molds/cores to improve casting surface quality.",
  fettling: "Cleaning/finishing castings after they leave the mould.",

  // —— Printing / packaging ——
  gravure: "Rotogravure — image engraved on a cylinder for high-volume print.",
  rotogravure: "Gravure printing with engraved cylinders — packaging/print.",
  "printing cylinders": "Engraved cylinders used in gravure printing.",
  "cylinder + engraving": "Engraving image cells into a gravure printing cylinder.",
  flexo: "Flexographic printing — relief plate process widely used for packaging.",
  flexographic: "Flexo printing process using flexible relief plates.",
  "printing + plates": "Plates that transfer ink in flexo/offset printing.",
  anilox: "Engraved roller that meters ink onto the plate in flexo printing.",
  "flexible packaging":
    "Films/laminates/pouches — flexible packs vs rigid bottles/tins.",
  paperboard: "Thick paper stock used for cartons and packaging.",
  "paper board": "Thick paper stock used for cartons and packaging.",
  cartons: "Folded paperboard boxes for packaging goods.",
  "mono cartons": "Single-layer paperboard cartons (often printed).",
  "folding cartons": "Printed paperboard cartons that fold flat then erect.",
  corrugated: "Fluted paperboard used for shipping cartons.",
  bopp: "Biaxially Oriented Polypropylene — common packaging film.",
  "packaging films": "Plastic films used to wrap or laminate packaged goods.",
  laminates: "Multi-layer films/foils bonded for barrier packaging.",
  "duplex board": "Paperboard grade often used for printed cartons.",
  kraft: "Strong paper/board made from kraft pulp — bags, liners, cartons.",
  "rigid packaging": "Hard packs — bottles, jars, trays, containers.",
  "plastic packaging": "Packaging made primarily from plastics.",
  closures: "Caps/lids that seal bottles and containers.",
  "caps + closures": "Caps and sealing closures for bottles/containers.",
  // —— PVC / plastic pipes ——
  pvc: "Polyvinyl chloride — common plastic resin for pipes, fittings, profiles, and sheets.",
  upvc: "Unplasticized PVC — rigid PVC for pressure/drainage pipes and window profiles.",
  cpvc: "Chlorinated PVC — hotter-water plumbing pipes/fittings (also made as resin by chemical cos).",
  swr: "Soil, Waste & Rainwater — Indian drainage/sewer pipe category (usually PVC).",
  pipes: "Tubular products for carrying water, gas, effluent, or protecting cables.",
  fittings: "Connectors (elbows, tees, couplers) that join pipe runs.",
  plumbing: "Indoor water supply and sanitary piping systems.",
  irrigation: "Farm/landscape water delivery — often plastic pipes or drip systems.",
  conduit: "Tube that protects electrical cables (often PVC).",
  polymer: "Large-molecule plastic/material family — very generic in company About text.",
  "pvc + pipes":
    "Polyvinyl chloride pipes — plastic pressure/drainage pipes for water, plumbing, agri.",
  "pvc + fittings": "PVC joints/elbows/tees/couplers that connect PVC pipe runs.",
  "pipes + fittings":
    "Pipe systems plus connectors — common phrase; weak as a standalone theme keyword.",
  "plastic + pipes": "Pipes made of plastic (PVC/HDPE/etc.) — broad match.",
  "plumbing + pipes": "Pipes for indoor water/sanitary plumbing — not material-specific.",
  "irrigation + pipes": "Pipes used in farm irrigation (PVC/HDPE); also matches drip firms.",
  "swr + pipes": "Soil, Waste & Rainwater drainage/sewer pipes — usually PVC in India.",
  "conduit + pipes": "Electrical conduit pipes that protect wiring — often PVC.",
  "polymer + pipes": "Marketing-speak for plastic pipes — broad false-positive term.",
  "sustainable + packaging":
    "Packaging designed for lower environmental impact / recyclability.",
  "moulded + pulp": "3D packaging formed from pulp fibre (trays, inserts).",
  "molded + pulp": "3D packaging formed from pulp fibre (trays, inserts).",
  "pet + preforms": "PET preforms that are blow-moulded into bottles.",
  preforms: "PET blanks later blown into bottles.",
  pouches: "Flexible sealed bags used as primary packaging.",
  sachets: "Small single-use flexible packets.",
  "stand-up pouches": "Flexible pouches that stand on a gusseted base.",
  packaging: "Materials and formats that contain and protect products.",

  // —— Coated steel ——
  "alu-zinc": "Aluminium–zinc coated steel (Galvalume-type) for corrosion resistance.",
  aluzinc: "Aluminium–zinc coated steel for corrosion-resistant sheet.",
  galvalume: "Al–Zn coated steel brand/type used for roofing and cladding.",
  "pre-painted": "Steel coil painted before fabrication (colour-coated).",
  prepainted: "Steel coil painted before fabrication (colour-coated).",
  "colour coated": "Steel with a factory-applied colour paint system.",
  "color coated": "Steel with a factory-applied colour paint system.",
  galvanising: "Coating steel with zinc for corrosion protection.",
  galvanizing: "Coating steel with zinc for corrosion protection.",
  galvanised: "Steel coated with zinc.",
  galvanized: "Steel coated with zinc.",
  "coated + steel": "Steel with metallic and/or organic coatings.",
  "colour + coating + line":
    "Production line that paints/coats steel coil continuously.",
  cgl: "Continuous Galvanising Line — coats steel strip with zinc continuously.",
  "continuous galvanising":
    "Continuous process that zinc-coats steel strip on a line.",
  tinplate: "Thin steel coated with tin — cans and packaging.",

  // —— Auto ——
  "auto component": "Part supplied into vehicle manufacturing (OEM/aftermarket).",
  "auto components": "Parts supplied into vehicle manufacturing.",
  automotive: "Related to motor vehicles and their supply chain.",
  "auto ancillary": "Auto-component supplier industry supporting OEMs.",
  ancillary: "Supporting supplier industry (often auto components).",
  "wiring harness": "Bundled wires/connectors that distribute power/signals in a vehicle.",
  "auto forging": "Forged metal parts for automotive use.",
  "auto fasteners": "Bolts/screws/clips made for automotive assembly.",
  "die casting + auto": "Die-cast metal parts for automotive applications.",
  "die casting": "Forcing molten metal into a steel die under pressure.",
  "two-wheeler": "Motorcycle/scooter segment.",
  "three-wheeler": "Auto-rickshaw / three-wheel vehicle segment.",
  "tractor + component": "Parts made for agricultural tractors.",
  "tier-1": "Tier-1 auto supplier — sells assemblies directly to vehicle OEMs.",
  "tier 1": "Tier-1 auto supplier — sells assemblies directly to vehicle OEMs.",
  "stamping + auto": "Pressed/stamped sheet-metal parts for vehicles.",
  pressings: "Pressed sheet-metal parts.",
  stamping: "Forming sheet metal in a press.",
  brake: "Vehicle braking system or brake components.",
  "suspension + auto": "Vehicle suspension parts — arms, links, dampers, etc.",
  steering: "Vehicle steering system / components.",
  axles: "Shaft assemblies that carry wheels and transmit drive.",
  rims: "Wheel rims.",
  bumpers: "Vehicle bumper assemblies.",
  "radiators + auto": "Vehicle engine/EV thermal radiators.",
  radiators: "Heat exchangers that dump heat to air.",
  exhaust: "Vehicle exhaust system components.",
  "fuel injection": "System that meters fuel into an ICE engine.",
  "commercial vehicle + component": "Parts for trucks/buses/CVs.",
  "passenger vehicle": "Cars for personal passenger use.",
  adas: "Advanced Driver Assistance Systems — camera/radar/software safety features.",
  "driver monitoring": "Cabin camera/system that watches driver attention (ADAS).",

  // —— Pharma ——
  cdmo: "Contract Development & Manufacturing Org — develops/makes drugs for pharma clients.",
  "contract development and manufacturing":
    "CDMO model — develop and manufacture medicines for sponsor companies.",
  crams: "Contract Research and Manufacturing Services — outsourced pharma R&D + make.",
  "contract manufacturing + pharmaceutical":
    "Making pharma products under contract for brand owners.",
  "contract manufacturing + formulations":
    "Contract manufacture of finished dosage forms.",
  "contract manufacturing + electronics":
    "Building electronics under contract for brand owners.",
  "contract manufacturing":
    "Making products for another company under contract.",
  api: "Active Pharmaceutical Ingredient — the active drug substance.",
  "active pharmaceutical ingredients":
    "APIs — biologically active drug substances in medicines.",
  "api + intermediates": "Chemical intermediates used to make APIs.",
  "custom synthesis": "Making customer-specified molecules to order.",
  injectables: "Injectable medicines (vials, ampoules, prefilled syringes).",
  "sterile + injectables": "Aseptically manufactured injectable drugs.",
  "oral solid dosage": "Tablets and capsules (OSD).",
  osd: "Oral Solid Dosage — tablets and capsules.",
  "who-gmp": "WHO Good Manufacturing Practice — quality standard for medicines.",
  usfda: "US Food and Drug Administration — US drug/device regulator.",
  "eu-gmp": "European Union Good Manufacturing Practice standard.",
  "fixed dose combinations": "Medicines combining two+ actives in one dose.",
  "tech transfer + pharma":
    "Transferring a manufacturing process between sites/companies.",
  "tech transfer": "Moving a production process to another plant or partner.",
  "nutraceuticals + manufacturing": "Making dietary supplements / nutraceutical products.",
  nutraceuticals: "Food-derived products with claimed health benefits.",
  nutraceutical: "Food-derived product with claimed health benefits.",
  "pharma + manufacturing": "Manufacturing pharmaceutical products.",
  "formulations + manufacturing": "Making finished dosage forms (tablets, liquids, etc.).",
  formulations: "Finished medicine products (not just the raw API).",
  lyophilization: "Freeze-drying — used for many sterile injectable products.",
  "biosimilar + manufacturing": "Making follow-on biologic drugs (biosimilars).",
  biosimilar: "Highly similar version of an approved biologic medicine.",
  "veterinary + formulations": "Animal-health finished medicines.",
  pharmaceutical: "Related to medicines and drug products.",
  pharma: "Pharmaceutical industry / medicines.",

  // —— Chemicals / additives / agri ——
  pib: "Polyisobutylene — polymer for lubricant additives, sealants, adhesives.",
  polyisobutylene:
    "PIB — polymer for lubricant additives, sealants, adhesives.",
  "lubricant additive": "Chemical that improves lubricating oil performance.",
  "fuel additive": "Chemical added to fuel to improve performance/stability.",
  "rubber processing chemicals": "Chemicals used when compounding/processing rubber.",
  "viscosity modifier": "Additive that improves oil viscosity across temperatures.",
  dispersant: "Additive that keeps particles/sludge suspended in oil.",
  "base oil": "Main refined oil stock before additive packages are blended.",
  "lubricant + blending": "Blending base oils with additives into finished lubricants.",
  lubricant: "Oil/grease that reduces friction and wear.",
  maize: "Corn — feedstock for starch and sweetener derivatives.",
  "corn + starch": "Starch extracted from maize/corn.",
  starch: "Carbohydrate polymer from crops — industrial and food uses.",
  sorbitol: "Sugar alcohol from glucose — food, pharma, personal care.",
  "glucose syrup": "Concentrated glucose solution from starch hydrolysis.",
  dextrin: "Partially hydrolysed starch used as binder/adhesive/food ingredient.",
  maltodextrin: "Mildly hydrolysed starch powder — food/pharma bulking agent.",
  "glucose + derivatives": "Products derived from glucose (syrups, polyols, etc.).",
  "corn + wet milling": "Process that separates corn into starch, germ, fibre, protein.",
  "starch + derivatives": "Modified/converted products made from starch.",
  "liquid + glucose": "Liquid glucose syrup from starch.",
  "modified + starch": "Chemically/physically altered starch for specific functions.",
  "drip + irrigation": "Micro-irrigation that drips water to plant roots.",
  sprinkler: "Irrigation method that sprays water over crops.",
  "micro irrigation": "Low-volume irrigation — drip/micro-sprinklers.",
  "precision farming": "Data-driven farming for precise input use.",
  "water + conservation": "Practices/products that reduce water use.",
  "irrigation + systems": "Equipment that delivers water to crops.",
  "drip + lines": "Tubing that delivers drip irrigation to plants.",
  emitters: "Drip-irrigation outlets that meter water to plants.",
  fertigation: "Feeding fertiliser through the irrigation water.",
  "micro + sprinklers": "Small sprinklers used in micro-irrigation.",
  "water + management + agriculture":
    "Managing farm water use — irrigation, storage, efficiency.",

  // —— Food processing ——
  "mango pulp": "Processed mango flesh used as food ingredient.",
  puree: "Smooth pulp of fruit/vegetables.",
  aseptic: "Sterile processing/pack so food stays shelf-stable without fridge.",
  "spray dried": "Drying a liquid into powder by spraying into hot air.",
  "fruit + processing": "Industrial processing of fruit into pulp/juice/concentrate.",
  tetra: "Often Tetra Pak-style aseptic carton packaging.",
  "concentrates + fruit": "Concentrated fruit juice/pulp for later reconstitution.",
  "fruit + pulp": "Processed fruit flesh used as an ingredient.",
  "tomato + paste": "Concentrated cooked tomato product.",
  "frozen + vegetables": "Vegetables preserved by freezing.",
  iqf: "Individually Quick Frozen — pieces frozen separately so they stay free-flowing.",
  "dehydrated + onion": "Onion preserved by drying.",
  oleoresins: "Solvent-extracted spice/plant concentrates.",
  "fruit + juice + concentrate": "Fruit juice with most water removed.",

  // —— Solar / renewables ——
  epc: "Engineering, Procurement and Construction — turnkey project delivery.",
  "solar + epc": "Turnkey engineering/procurement/construction of solar plants.",
  "rooftop + solar": "Solar PV installed on building rooftops.",
  "solar + project": "A developed/built solar power project.",
  "solar + park": "Utility-scale solar plant on a contiguous site.",
  "solar + installation": "Installing solar PV systems.",
  "solar + module": "Solar photovoltaic panel.",
  "solar + pump": "Solar-powered water pump (often agricultural).",
  "ground mounted + solar": "Solar arrays mounted on the ground (not rooftop).",
  "utility scale + solar": "Large grid-connected solar plants (MWs).",
  "captive + solar": "Solar plant built mainly to supply one industrial consumer.",
  "solar + o&m": "Operations & maintenance services for solar plants.",
  "o&m": "Operations and Maintenance — running and servicing an asset.",
  "renewable + epc": "Turnkey EPC for renewable energy projects.",
  "solar + developer": "Company that develops (and often sells) solar projects.",
  "module + mounting": "Structures that hold solar modules in place.",
  "solar + tracker": "Mount that tilts modules to follow the sun.",
  solar: "Solar photovoltaic or solar thermal energy.",
  renewable: "Energy from sources that replenish — solar, wind, etc.",

  // —— Oilfield / offshore / seismic ——
  "offshore support vessel": "Ship that supports offshore oil/gas/wind operations.",
  osv: "Offshore Support Vessel — support ship for offshore ops.",
  dsv: "Diving Support Vessel — ship equipped for diving/ROV work.",
  "diving support": "Vessels/services that support offshore diving operations.",
  subsea: "Equipment/operations on the seabed.",
  rov: "Remotely Operated Vehicle — tethered underwater robot.",
  "charter hire": "Day rate paid to hire a vessel.",
  drydocking: "Taking a ship into dry dock for inspection/repair.",
  "offshore + vessel": "Ship designed for offshore energy work.",
  "anchor handling": "Handling/setting anchors for offshore rigs/vessels.",
  "supply + vessel": "Vessel that ferries supplies to offshore platforms.",
  ahts: "Anchor Handling Tug Supply — vessel that sets anchors and supplies platforms.",
  "platform + supply": "Supplying offshore platforms with materials and fuel.",
  "offshore + construction": "Building/installing offshore structures.",
  underwater: "Operations performed under water.",
  hyperbaric: "High-pressure environment — e.g. diving systems.",
  "saturation + diving": "Long-duration diving where divers stay pressurised.",
  "offshore + oilfield": "Oil & gas fields and ops located offshore.",
  seismic: "Using sound waves to map underground geology.",
  geophysical: "Physics-based survey of earth structure (seismic, etc.).",
  "hydrocarbon exploration": "Searching for oil and gas deposits.",
  subsurface: "Below the ground surface — reservoirs, geology.",
  "survey + crews": "Field crews that run geophysical/survey operations.",
  geotechnical: "Engineering study of soil/rock for foundations and structures.",
  borehole: "Drilled hole used for exploration, sampling, or production.",
  "well + logging": "Measuring rock/fluid properties in an oil/gas well.",
  wireline: "Cable-deployed tools for well logging and interventions.",
  "mud + logging": "Analysing drilling mud/cuttings for formation info.",
  "core + drilling": "Drilling to recover rock core samples.",
  "exploration + services": "Services that support oil/gas/mineral exploration.",
  "e&p + services": "Services for Exploration & Production companies.",
  "e&p": "Exploration & Production — upstream oil & gas.",

  // —— TMT / steel long products ——
  tmt: "Thermo-Mechanically Treated rebar — high-strength construction steel bars.",
  "tmt + bars": "TMT rebars used in reinforced concrete construction.",
  saria: "Colloquial term for steel rebar/TMT bars in India.",
  rebar: "Reinforcing bar embedded in concrete.",
  "royalty + income": "Income from licensing a brand/process (e.g. TMT franchise).",
  "franchise + steel": "Licensed brand model for producing steel products.",
  "structural + steel": "Steel shapes used in buildings and structures.",
  "steel + long products": "Long steel products — rebar, wire rod, sections.",
  "long + products + steel": "Long steel products — rebar, wire rod, sections.",
  "wire + rod": "Hot-rolled steel rod used to draw wire.",

  // —— Gems / jewellery ——
  diamond: "Gem crystal of carbon — mined or lab-grown.",
  "lab grown": "Lab-grown diamond created by CVD/HPHT, not mined.",
  lgd: "Lab-Grown Diamond — diamond made by CVD/HPHT.",
  "cvd + diamond": "Diamond grown by Chemical Vapour Deposition.",
  cvd: "Chemical Vapour Deposition — used to grow lab diamonds and coatings.",
  jewellery: "Ornaments made with precious metals and stones.",
  jewelry: "Ornaments made with precious metals and stones.",
  studded: "Jewellery set with diamonds/gemstones.",
  ornaments: "Decorative jewellery pieces.",
  bangles: "Rigid bracelet-style jewellery.",
  necklaces: "Jewellery worn around the neck.",
  bridal: "Wedding/bridal jewellery category.",
  "wedding + jewellery": "Jewellery made for wedding occasions.",
  "temple + jewellery": "Traditional temple-style Indian jewellery designs.",
  gemstone: "Precious or semi-precious stone used in jewellery.",
  "gem stone": "Precious or semi-precious stone used in jewellery.",
  "precious stones": "High-value gemstones (diamond, ruby, emerald, etc.).",
  polki: "Uncut diamond jewellery style popular in India.",
  kundan: "Traditional Indian gold jewellery set with stones in lac/gold foil.",
  hallmark: "Official purity mark on precious-metal jewellery.",

  // —— Hospitals / healthcare ——
  hospital: "Facility providing inpatient medical care.",
  "multi-specialty": "Hospital covering many medical specialties.",
  multispecialty: "Hospital covering many medical specialties.",
  "super speciality": "Hospital focused on advanced specialty care.",
  superspeciality: "Hospital focused on advanced specialty care.",
  "tertiary care": "Specialised referral hospital care.",
  "quaternary care": "Highly specialised / experimental care beyond tertiary.",
  "medical tourism": "Patients travelling for medical treatment.",
  icu: "Intensive Care Unit — critical-care ward.",
  diagnostics: "Medical tests used to identify disease.",
  pathology: "Lab testing of tissues/fluids for diagnosis.",
  radiology: "Medical imaging specialty (X-ray, CT, MRI, etc.).",
  "imaging + services": "Diagnostic imaging services for patients.",
  mri: "Magnetic Resonance Imaging — detailed soft-tissue scans.",
  "cath lab": "Catheterization lab for heart procedures.",
  ivf: "In Vitro Fertilisation — assisted reproductive treatment.",
  fertility: "Reproductive / infertility treatment services.",
  dialysis: "Treatment that filters blood when kidneys fail.",
  oncology: "Cancer care specialty.",
  "home care + medical": "Medical services delivered at the patient’s home.",
  telemedicine: "Remote clinical consultation via telecom/video.",
  "pharmacy + retail": "Retail sale of medicines.",
  "healthcare + services": "Medical and related care services.",
  clinics: "Outpatient medical facilities.",
  healthcare: "Medical care industry and services.",

  // —— Real estate ——
  redevelopment: "Rebuilding older properties, often denser/modern.",
  "slum rehabilitation": "Rehousing slum dwellers, often via SRA-type schemes.",
  sra: "Slum Rehabilitation Authority (Mumbai) — slum redevelopment framework.",
  tdr: "Transferable Development Rights — saleable extra buildable FSI.",
  fsi: "Floor Space Index (FAR) — allowed built-up area vs plot size.",
  "cluster development": "Redeveloping a cluster of old buildings together.",
  "society redevelopment": "Redeveloping a cooperative housing society.",
  "tenanted properties": "Buildings occupied by tenants (common in Mumbai redevelopment).",
  "real estate + mumbai": "Property development activity in Mumbai.",
  "residential + commercial development":
    "Developing homes and/or commercial real estate.",
  "redevelopment + projects": "Active projects that rebuild existing properties.",
  "in-situ rehabilitation": "Rehabilitating residents on the same site.",

  // —— Financials ——
  nbfc: "Non-Banking Financial Company — lends/invests without a full bank licence.",
  "non-banking financial": "NBFC-type financial services outside full banking.",
  microfinance: "Small loans to low-income borrowers / SHGs.",
  "micro finance": "Small loans to low-income borrowers / SHGs.",
  "housing finance": "Loans for buying/building homes.",
  "wealth management": "Advisory/management of affluent client investments.",
  "asset management": "Running mutual funds / portfolios for investors.",
  broking: "Stock/commodity brokerage services.",
  "merchant banking": "Capital-markets advisory — IPOs, placements, M&A.",
  "primary dealer": "Authorised dealer in government securities with RBI obligations.",
  gilts: "Government securities / sovereign bonds.",
  gilt: "Government security / sovereign bond.",
  "g-sec": "Government security — sovereign bond/bill.",
  "government securities": "Bonds/bills issued by the government.",
  "treasury bills": "Short-term government discount instruments (T-bills).",
  "t-bills": "Treasury bills — short-term government paper.",
  lending: "Providing credit/loans.",
  "credit + finance": "Lending and related credit products.",
  "sme + lending": "Loans to small and medium enterprises.",
  sme: "Small and Medium Enterprise.",
  "two-wheeler + finance": "Loans for buying scooters/motorcycles.",
  "digital lending": "Credit originated/served mainly through digital channels.",
  "fintech + lending": "Technology-led lending platforms/products.",
  factoring: "Buying receivables to give suppliers early cash.",
  "lease + finance": "Financing equipment/vehicles via leases.",
  "investment banking": "Advisory and underwriting for capital markets / M&A.",
  "portfolio management": "Managing investment portfolios for clients.",
  pms: "Portfolio Management Services — managed equity accounts.",
  aif: "Alternative Investment Fund — pooled PE/VC/hedge-style vehicle.",
  "depository + services": "Holding securities in demat form for investors.",
  "registrar + transfer": "RTA — handles share registry and investor records.",
  rta: "Registrar & Transfer Agent — share registry services.",
  "underwriting + securities": "Guaranteeing/placing a securities issue.",
  underwriting: "Taking risk to place an issue or insure a risk.",
  "infrastructure + finance": "Lending to infrastructure projects.",
  "issue management": "Managing a public/rights issue process.",
  "book running": "Running the order book for an IPO/issue.",
  "lead + manager": "Lead investment bank on an issue.",
  "capital markets + advisory": "Advice on IPOs, placements, listings, etc.",
  "ipo + advisory": "Advice for companies preparing an IPO.",
  ipo: "Initial Public Offering — first public share sale.",
  "pre-ipo": "Financing/advisory before a company goes public.",
  "private + placement + advisory": "Advice on placing shares with select investors.",
  "m&a + advisory": "Advice on mergers and acquisitions.",
  "mergers + acquisitions + advisory": "Advice on buying/selling/merging companies.",
  "corporate + advisory": "Strategic/financial advice to companies.",
  "market making": "Providing continuous two-way quotes to add liquidity.",
  "fixed income": "Debt instruments — bonds, bills, credit.",
  "bond + trading": "Buying/selling bonds in the secondary market.",
  "debt + markets": "Markets for bonds and other debt instruments.",
  "sovereign + bonds": "Bonds issued by a national government.",
  finance: "Provision of capital and financial services.",
  fintech: "Technology applied to financial services.",
  credit: "Lending / ability to borrow.",
  debt: "Borrowed capital that must be repaid.",
  bonds: "Tradable debt instruments.",
  bond: "Tradable debt instrument.",

  // —— Misc industrials ——
  conductor: "Material/path that carries electric current.",
  components: "Parts that go into a larger product or system.",
  component: "A part that goes into a larger product or system.",
  industrial: "Related to factories, capital goods, and industry.",
  engineering: "Design and application of technology to build products/systems.",
};

const ALIASES: Record<string, string> = {
  "bus-bar": "busbar",
  "bus-bars": "bus bars",
  "continuously transposed conductor": "ctc",
  "battery energy storage systems": "bess",
  "printed circuit board": "pcb",
  "surface mount technology": "smt",
  "gas insulated substation": "gis",
  "on-load tap changer": "oltc",
  "on load tap changer": "oltc",
  "lab-grown": "lab grown",
  "lab grown diamond": "lgd",
  "lab-grown diamond": "lgd",
  "non banking financial": "nbfc",
  "thermo-mechanically treated": "tmt",
  "thermomechanically treated": "tmt",
  "electric vehicle components": "ev components",
  "galvalume®": "galvalume",
  "tetra pak": "tetra",
  "floor space index": "fsi",
  "floor area ratio": "fsi",
  "transferable development right": "tdr",
  "transferable development rights": "tdr",
  "advanced driver assistance systems": "adas",
  "advanced driver assistance system": "adas",
  "battery management system": "battery + management",
  "battery management": "battery + management",
  bms: "battery + management",
  "cell connecting": "cell connecting system",
  "enamelled copper wire": "enamelled wire",
  "enamel wire": "enamelled wire",
  "magnet wires": "magnet wire",
  "winding wires": "winding wire",
  "power transformers": "power transformer",
  "distribution transformers": "distribution transformer",
  transformers: "transformer",
  capacitors: "capacitor",
  conductors: "conductor",
  "smart-meter": "smart meter",
  "smart-meters": "smart meters",
  "pcb assemblies": "pcb assembly",
  "printed circuit boards": "printed circuit board",
  "gas-insulated switchgear": "gis",
  "sf6": "gis",
};

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[’']/g, "'");
}

const FALLBACK =
  "Theme-scan match — product/process term from this company’s about text.";

function lookup(map: Record<string, string>, key: string): string | undefined {
  if (map[key]) return map[key];
  const via = ALIASES[key];
  if (via && map[via]) return map[via];
  if (key.endsWith("s") && key.length > 3) {
    const singular = key.slice(0, -1);
    if (map[singular]) return map[singular];
    const viaS = ALIASES[singular];
    if (viaS && map[viaS]) return map[viaS];
  }
  return undefined;
}

/** Resolve a short plain-English tip for a highlighted phrase. */
export function keywordExplanation(raw: string): string | null {
  const key = norm(raw);
  if (!key) return null;
  const fromTheme = lookup(THEME_DEFS, key);
  if (fromTheme) return fromTheme;
  const fromStatic = lookup(DEFS, key);
  if (fromStatic) return fromStatic;
  // Always give a tip so hover is never empty for highlights.
  return FALLBACK;
}
