import { WorldPreset } from "../models/types";


export const WORLD_PRESETS: { [lang: string]: WorldPreset[]; } = {
    en: [
        {
            id: 'sword_magic',
            label: 'Sword & Magic',
            genre: 'High Fantasy',
            tone: 'Epic, Dark, Political Intrigue',
            setting: 'A medieval fantasy kingdom threatened by an ancient evil awakening in the north. Magic is rare and regulated by a powerful Mage Guild. Noble houses and church factions compete for influence over the throne.',
            identities: [
                {
                    value: 'Adventurer', specialRequests: '',
                    alignment: 'True Neutral', interests: 'Weapon maintenance, ruin exploration, gathering rumors',
                    npcHints: 'A reliable opposite-sex partner (carrying secrets), the mysterious backer behind the job posting, a rival competing for the same contract',
                    appearance: 'Lean and weathered, early 30s, a few faded scars, practical short hair — unremarkable at a glance, which has saved their life more than once.',
                    desc: 'A capable but unremarkable adventurer in their early 30s — skilled with a blade, experienced enough to know when to run. No grand destiny, just trying to make a living. Recently arrived in the capital chasing a rumor of well-paying work.'
                },
                {
                    value: 'Knight', specialRequests: '',
                    alignment: 'Lawful Neutral', interests: 'Sword training, riding, heraldry',
                    npcHints: 'A knowing attendant or lady-in-waiting, the protagonist\'s liege lord (secret holder), a rival knight or political enemy',
                    appearance: 'Tall and broad-shouldered, close-cropped hair, the disciplined posture of someone who has worn armor since adolescence.',
                    desc: 'A mid-ranking knight sworn to a minor noble house. Loyal, disciplined, and quietly aware that their lord is involved in something they should not be.'
                },
                {
                    value: 'Guild Mage', specialRequests: '',
                    alignment: 'Neutral Good', interests: 'Magic theory, herbalism, stargazing',
                    npcHints: 'A talented opposite-sex colleague (layered personality), a suspicious Guild inspector keeping tabs on the protagonist, a field-contract client who is an unwitting pawn',
                    appearance: 'Slight build, ink-stained fingers, sharp eyes behind an occasionally distracted expression — hair usually tied back and usually coming loose.',
                    desc: 'A journeyman mage licensed by the Guild — enough talent to pass the trials, not enough connections to climb fast. Takes field contracts to pay for research materials.'
                },
                {
                    value: 'Sellsword', specialRequests: '',
                    alignment: 'Chaotic Neutral', interests: 'Weapon trading, map collecting, gambling (occasionally)',
                    npcHints: 'A long-time opposite-sex partner, a black-market information broker (job source), an enemy from the past who knows the protagonist\'s weaknesses',
                    appearance: 'Stocky and road-worn, mid-30s, a collection of minor scars, the patient stillness of someone who has waited out ambushes before.',
                    desc: 'A veteran mercenary with no allegiances and a list of completed contracts that says more about survival than glory. Currently between jobs and low on coin.'
                },
                {
                    value: 'Transmigrator · Hard', specialRequests: 'No cheat skill. The protagonist has their own body and modern clothes — visibly out of place and completely powerless in a world that runs on magic they cannot access.',
                    alignment: 'Chaotic Good', interests: 'problem-solving, history, cooking',
                    npcHints: 'An opposite-sex local who takes the protagonist in (the survival anchor), a suspicious local who keeps noticing how strange the protagonist\'s thinking is (potential future ally or threat), a mage scholar who finds the protagonist\'s non-magical problem-solving unexpectedly valuable',
                    appearance: 'Completely normal modern person — jeans, jacket, sneakers, dead phone. Extremely out of place.',
                    desc: 'A regular modern person — dropped into a medieval fantasy world for reasons unknown, with no golden finger and no magic affinity. Survival is day-to-day. The only thing working is a functioning brain — which, in this world, ranks below being able to cast a fireball.'
                },
                {
                    value: 'Transmigrator · Standard', specialRequests: 'Give the protagonist 1–2 abilities that are genuinely unusual but provide no immediate combat power. The ability should affect their growth ceiling, not their starting floor. Good examples: perfect retention of any spell or technique they study once (but they still need the mana affinity and practice to execute it), a low-grade system that offers appraisal and knowledge but no stat bonuses, or an innate sense for magical flows that accelerates learning without granting any power directly. The protagonist starts genuinely vulnerable — early scenes can involve real danger, real setbacks, and needing help from others. The cheat\'s significance should become apparent gradually, through the growth curve, not announced in the opening scene.',
                    alignment: 'Chaotic Good', interests: 'pattern recognition, problem-solving, adaptability',
                    npcHints: 'An opposite-sex local who helps the protagonist survive before the edge becomes obvious (genuine bond, formed before any power gap opens), a mage or scholar who notices the protagonist\'s learning pattern is structurally unusual and starts asking questions, a threat the protagonist cannot yet handle with current ability — requiring creative use of the limited edge to survive',
                    appearance: 'Completely normal modern person — jeans, jacket, sneakers, dead phone. Nothing about them belongs in this century.',
                    desc: 'A regular modern person who arrived in a medieval fantasy world with one or two quietly unusual abilities — not enough to dominate, just enough to eventually bend the trajectory. The early weeks still involve scrambling, asking for help, and failing in ways that hurt. The difference from everyone else isn\'t visible yet.'
                },
                {
                    value: 'Transmigrator · Overpowered', specialRequests: 'Include a system interface with at least two active cheat functions (e.g. universal appraisal, skill copying, accelerated learning), a hidden top-tier magic affinity that activates on arrival, and a spatial storage ring loaded with basic supplies. The cheats compound — within weeks, the power curve becomes hard to explain.',
                    alignment: 'Chaotic Good', interests: 'gaming, optimization',
                    npcHints: 'An opposite-sex companion from before the power spike (genuine dynamic, not power-attracted), a local genius who notices the protagonist\'s impossible growth rate, a major faction that decides the protagonist needs to be recruited — or removed',
                    appearance: 'Arrived in modern clothes. Now dressed in whatever the system flagged as optimal loot. A magic affinity reading that made the Guild examiner re-run the test three times.',
                    desc: 'A regular modern person who arrived in a medieval fantasy world with a full system HUD, two starting skills, a storage ring, and a magic affinity the Guild rating scale wasn\'t built to display. The local prodigies are working hard. The protagonist is following system notifications. Not everyone has noticed the gap yet.'
                },
                {
                    value: 'Reincarnated Noble', specialRequests: 'Include a "cheat skill" and political intrigue centered on the protagonist\'s noble house. The protagonist has foreknowledge of how their family\'s plot ends.',
                    alignment: 'Lawful Good', interests: '(Past life) light novels; (this life) house politics, equestrian',
                    npcHints: 'A political match who develops feelings for the protagonist, a loyal attendant who noticed the change before and after (only one who suspects), the story\'s main villain NPC (not yet on stage)',
                    appearance: 'Young noble\'s face and frame — well-fed, well-groomed, soft hands. Nothing in the body matches the mind currently running it.',
                    desc: 'Woke up in the body of a young scion of a minor noble house, with all past-life memories intact. Knows how the story is "supposed" to go — and exactly how badly it ends for people like them.'
                },
                {
                    value: 'Summoned Hero', specialRequests: 'Include a "cheat skill", the weight of prophecy, and rival factions competing to control the hero\'s allegiance.',
                    alignment: 'Neutral Good', interests: '(Past life) gaming; (now) still adapting',
                    npcHints: 'An escorting knight or sage, a priest or royal agent manipulating the hero behind the scenes, a powerful enemy who may become an unlikely ally',
                    appearance: 'Average modern build, still in whatever they were wearing that morning. The hero crest is new; everything else is not.',
                    desc: 'Pulled from the modern world by royal ritual and declared the prophesied hero. Surrounded by expectations they did not ask for. The hero crest is real; the confidence to match it is still pending.'
                },
                {
                    value: 'Reincarnated Villain', specialRequests: 'A destined rival exists in this world — a rising hero whose arc leads directly to confrontation with the protagonist. Include death flags and the villain\'s attempts to rewrite their fate before the story reaches them.',
                    alignment: 'Chaotic Neutral', interests: '(Past life) light novels; (this life) intelligence gathering, staying alive',
                    npcHints: 'A gifted young hero on a rising arc — whose path points directly at the protagonist, the villain faction\'s most loyal subordinate (the only one who senses something changed), a suspicious third party who notices the protagonist\'s odd behavior',
                    appearance: 'The villain\'s angular features and the kind of face people find hard to read — striking in a way that reads as untrustworthy even when smiling.',
                    desc: 'Died and woke up as the villain of a light novel they half-remember reading. The protagonist and their plot-armor are out there somewhere. Death flags need defusing. Soon.'
                },
            ]
        },
        {
            id: 'cyberpunk',
            label: 'Cyberpunk',
            genre: 'Cyberpunk / Near-Future Sci-Fi',
            tone: 'Gritty, Noir, High-Tech Low-Life',
            setting: 'A rain-soaked megacity in 2077 ruled by three rival megacorporations. The wealthy elite live in gleaming arcologies above the smog line while the masses scramble below. Cybernetic augmentation is cheap and ubiquitous.',
            identities: [
                {
                    value: 'Mercenary', specialRequests: 'Include black-market tech, underground resistance cells, and corporate espionage themes.',
                    alignment: 'Chaotic Neutral', interests: 'Weapon mods, underground fighting, black-market shopping',
                    npcHints: 'A reliable opposite-sex partner (carrying secrets), a shadowy information broker who feeds jobs to the protagonist, a corporate enforcer hired to hunt the protagonist down',
                    appearance: 'Wiry frame, augmented forearms visible under rolled sleeves, a few chrome implants at the temple — moves like someone conserving energy for when it matters.',
                    desc: 'A freelance merc in their late 20s — wiry, quick, and one bad job away from broke. Has basic combat augments and a reputation for getting things done without asking too many questions. Works out of the lower city.'
                },
                {
                    value: 'Hacker', specialRequests: 'Include black-market tech, corporate data vaults, and the lethal risk of ICE (Intrusion Countermeasure Electronics).',
                    alignment: 'Chaotic Good', interests: 'System cracking, black-market software, underground music',
                    npcHints: 'A real-world fixer or safe-house contact (provides resources), a useful corporate mole with complicated motives, a corporate ICE hunter tracking the protagonist',
                    appearance: 'Pale from too much screen time, neural interface ports at the base of the skull, comfortable clothes that look like they\'ve been slept in.',
                    desc: 'A netrunner who operates from a cramped apartment and a stolen deck. Can pull data from anywhere; getting paid for it is the hard part. Currently owes the wrong people a favor.'
                },
                {
                    value: 'Corporate Drone', specialRequests: 'Include corporate espionage, a whistleblower dilemma, and the existential danger of knowing too much about the wrong people.',
                    alignment: 'Lawful Neutral', interests: 'Data analysis, reading corporate politics, fine dining',
                    npcHints: 'A colleague in the same dangerous position (shared predicament), a resistance contact who wants the protagonist\'s inside information, a superior or rival working to silence the protagonist',
                    appearance: 'Neat professional appearance that\'s been maintained through visible stress — pressed suit, tired eyes, a practiced smile that doesn\'t quite reach them.',
                    desc: 'Mid-level white-collar at one of the megacorps — enough clearance to see things they were not supposed to see, not enough rank to be untouchable. The clock is already ticking.'
                },
                {
                    value: 'Street Medic', specialRequests: 'Include black-market augments, underground resistance networks, and the ethics of patching up people from every side of a conflict.',
                    alignment: 'Neutral Good', interests: 'Off-the-books medical research, black-market pharmaceuticals, underground music',
                    npcHints: 'A regular patient (an injured informant or ex-gang member), a gang leader trying to leverage the protagonist\'s clinic and contacts, a high-profile patient who arrives with too much trouble attached',
                    appearance: 'Quick, steady hands, a medical bag that never leaves arm\'s reach, the eyes of someone who has triaged under fire.',
                    desc: 'An underground doctor who patches up people the official clinics would report. Has contacts in three gangs, two resistance cells, and one very nervous corpo defector.'
                },
            ]
        },
        {
            id: 'wuxia',
            label: 'Wuxia',
            genre: 'Wuxia / Historical Fantasy',
            tone: 'Honor, Vendetta, Intrigue',
            setting: 'The prosperous yet turbulent jianghu of the Tang-Song era. The imperial court and the martial world coexist uneasily — powerful clans, Buddhist monasteries, and Daoist sects compete for supremacy. A lost relic tied to a legendary founding master has resurfaced, igniting a conflict that threatens to engulf both worlds.',
            identities: [
                {
                    value: 'Wandering Swordsman', specialRequests: 'Include a unique internal cultivation technique, jianghu vendettas, and a central mystery involving multiple factions.',
                    alignment: 'Chaotic Good', interests: 'Sword study, tea appreciation, visiting ruins of martial legend',
                    npcHints: 'An opposite-sex figure whose fate is entangled with the protagonist\'s (healer or noble descendant), a descendant of an old enemy (rival, possibly future ally), a morally grey elder figure who knows far more than they say',
                    appearance: 'Lean and quick, early 20s, plain traveling clothes, sword worn on the back as naturally as a coat — eyes that scan every room without seeming to.',
                    desc: 'A wandering swordsman of no fixed sect, early 20s. Trained under a reclusive master who died with secrets unspoken. Skilled, principled, and carrying a debt of vengeance — though the full shape of it is not yet clear.'
                },
                {
                    value: 'Sect Disciple', specialRequests: 'Include inter-sect rivalry, the hidden purpose behind the tournament, and a unique cultivation technique the sect is keeping secret.',
                    alignment: 'Lawful Good', interests: 'Martial arts practice, reading sect texts, sparring',
                    npcHints: 'A fellow disciple who knows the sect\'s secrets, a formidable rival from another sect (mutual respect), a senior figure who holds the key to the sect\'s real agenda',
                    appearance: 'Sect uniform, disciplined posture, hands strong from years of training, a face that looks younger than the eyes suggest.',
                    desc: 'A disciple of a mid-ranked martial sect, groomed for the inter-sect tournament and quietly suspicious that their sect master is hiding something about the tournament\'s real purpose.'
                },
                {
                    value: 'Imperial Constable', specialRequests: 'Include court politics entangled with jianghu factions, an unsolvable case with too many suspects, and pressure from above to close it fast.',
                    alignment: 'Lawful Neutral', interests: 'Case files, collecting records of jianghu figures, archery',
                    npcHints: 'An opposite-sex informant (a jianghu figure or a witness with inside knowledge), the main suspect with genuinely complex motives, a superior who represents the pressure coming from above',
                    appearance: 'Plain official\'s robe, practical rather than decorative, a constable\'s badge at the waist, and a steady watchful expression.',
                    desc: 'A lower-ranking constable serving the court\'s enforcement bureau — just competent enough to be assigned the cases no one else wants to touch.'
                },
                {
                    value: 'Scholar-Swordsman', specialRequests: 'Include the clash between court decorum and jianghu values, a secret martial tradition, and political dangers on both sides of the divide.',
                    alignment: 'Lawful Good', interests: 'Poetry and calligraphy, martial theory, tea ceremony',
                    npcHints: 'A court-born opposite-sex figure (a talented scholar or a noble lady), a loyal and plainspoken jianghu ally who respects the protagonist, a major rival from either the court or the martial world',
                    appearance: 'Scholar\'s robe over a surprisingly solid frame, ink at the fingertips — the sword belt doesn\'t quite match the outfit, which is the point.',
                    desc: 'A jinshi candidate who secretly trained in martial arts under a wandering master. Moves between the court world and the jianghu with a foot uncomfortably in both.'
                },
                {
                    value: 'Transmigrator · Hard', specialRequests: 'No cheat skill. The protagonist arrives as a modern person with no martial arts, no cultivation base, and no jianghu knowledge — in a world where both can get you killed.',
                    alignment: 'Chaotic Good', interests: 'history, food, problem-solving',
                    npcHints: 'A local guide who opens doors (a healer or wandering hero), a suspicious local who keeps noticing the protagonist\'s strange behavior (possible future ally), a righteous stranger who helps the protagonist enter jianghu circles',
                    appearance: 'Modern person — T-shirt, jeans, phone in pocket. Nothing about this fits. Everything needs explaining.',
                    desc: 'A regular modern person who blinked and found themselves standing at the edge of a Tang-Song era village — still in modern clothes, phone dead, no idea how they got here. Not a body-swap; this is their own body. No jianghu background, no cultivation, just common sense and the immediate problem of explaining their clothes.'
                },
                {
                    value: 'Transmigrator · Standard', specialRequests: 'Give the protagonist 1–2 abilities that are genuinely unusual in a martial context but provide no immediate combat power. The ability should raise the ceiling without raising the floor. Good examples: perfect muscle-memory retention (any technique practiced correctly once is permanently encoded — but the body still needs to be trained to execute it at speed), a passive killing-intent sense that provides warning but no combat boost, or a low-grade system that offers cultivation analysis and technique guidance without granting stat bonuses. The protagonist starts without fighting ability and can be genuinely threatened. The cheat\'s value is something a martial arts master might notice in retrospect — an unusual learning curve — not something that manifests as power on day one.',
                    alignment: 'Chaotic Good', interests: 'observation, pattern recognition, reading people',
                    npcHints: 'An opposite-sex jianghu figure who helps before the ability proves its worth (genuine bond), a martial arts master who notices the protagonist\'s learning curve doesn\'t match their experience level, a threat the protagonist cannot yet overcome — forcing creative use of the limited edge rather than direct confrontation',
                    appearance: 'Modern person — T-shirt, jeans, phone in pocket. Nothing about this fits. Everything needs explaining.',
                    desc: 'A regular modern person who arrived in the Tang-Song jianghu with one or two quietly unusual abilities — not enough to be dangerous today, but enough to eventually make them exceptional. Real effort, real danger, and real help from others are still required. The difference from everyone else is in the trajectory, not the starting point — and the trajectory isn\'t obvious yet.'
                },
                {
                    value: 'Transmigrator · Overpowered', specialRequests: 'Include a system interface with cheat functions (technique library access, instant cultivation comprehension, body-tempering bonuses), a hidden top-tier martial root that activates on arrival, and a spatial storage pouch with supplies and a few starter techniques. The protagonist goes from zero to alarming within months.',
                    alignment: 'Chaotic Good', interests: 'gaming, wuxia fiction',
                    npcHints: 'An opposite-sex jianghu figure who met the protagonist before the power became obvious (genuine bond), a sect elder who notices a junior\'s cultivation speed defies all known records, a jianghu faction that wants to lock down whatever the protagonist is doing',
                    appearance: 'Arrived in modern clothes; has since acquired proper jianghu attire. A cultivation base assessment that the evaluating senior had to repeat twice.',
                    desc: 'A regular modern person who arrived in a Tang-Song era cultivation world with a system interface, an instant language pack, a storage pouch of starter resources, and what the system calls a "Heaven-grade martial root." The protagonist of the local stories is grinding through their origin arc. The new arrival is three steps ahead.'
                },
                {
                    value: 'Reincarnated Scholar', specialRequests: 'Include the tension between historical foreknowledge and a timeline that is already diverging. The protagonist risks causing — or failing to prevent — events they thought they knew.',
                    alignment: 'Lawful Neutral', interests: '(Past life) historical research; (this life) tracking timeline divergence',
                    npcHints: 'An opposite-sex figure intrigued by the protagonist\'s uncanny knowledge (a gifted scholar or a noble\'s descendant), a superior or political rival (a historically important figure), a key historical figure whose behavior has already diverged from the record',
                    appearance: 'Low-ranking official\'s robes, ink-stained fingers, modern awareness looking out of a period face.',
                    desc: 'A modern historian who woke up as a low-ranking scholar-official in the Tang-Song era. Has detailed knowledge of how history is "supposed" to unfold — and the creeping horror of watching it quietly diverge.'
                },
                {
                    value: 'Reincarnated Villain', specialRequests: 'A destined rival exists in this world — a rising hero whose arc leads directly to confrontation with the protagonist. Include the villain\'s looming canonical death and the faction entanglements the villain was born into.',
                    alignment: 'Chaotic Neutral', interests: '(Past life) wuxia novels; (this life) intelligence gathering, death-flag removal',
                    npcHints: 'A gifted young swordsman on a rising arc whose path points directly at the protagonist, the villain faction\'s most loyal subordinate (devoted to the protagonist), a perceptive observer who notices the protagonist\'s changed behavior (threat or potential ally)',
                    appearance: 'The villain\'s striking angular features — the kind of face that people remember, and the kind of expression that makes them wish they didn\'t.',
                    desc: 'Died and woke up as the scheming antagonist of a wuxia novel they half-remember reading. The protagonist is a talented young swordsman on a fixed course toward this body\'s death. The clock is moving.'
                },
            ]
        },
        {
            id: 'xuanhuan',
            label: 'Cultivation Fantasy',
            genre: 'Xuanhuan / Chinese Cultivation Fantasy',
            tone: 'Ambition, Rivalry, Survival — power through cultivation',
            setting: 'A vast cultivation realm where power is the only law that matters. Cultivators ascend through rigidly defined stages — Qi Condensation, Foundation Building, Golden Core, Nascent Soul, and beyond — each breakthrough a battle against Heaven\'s will. Three great sects dominate the central territories, a hidden demonic order operates at the fringes, and ruins from an ancient war between immortals and demon gods litter the land with treasure and danger in equal measure. Spiritual roots determine destiny — and those born without talent must find another way, or disappear.',
            identities: [
                {
                    value: 'Rogue Cultivator', specialRequests: 'Include the dangers of cultivating without sect guidance, the black-market resource economy, and the constant predation of sect disciples who treat rogues as easy targets.',
                    alignment: 'True Neutral', interests: 'Scavenging ruins, pill refinement theory, formation arrays',
                    npcHints: 'A fellow rogue cultivator (shared survival, complicated trust), a black-market contact who knows where the dangerous opportunities are, a sect disciple who targets rogues for sport — and is about to learn why that\'s a mistake',
                    appearance: 'Unremarkable travelling clothes, a storage ring that has seen better days, the permanently alert expression of someone who has never had a truly safe place to sleep.',
                    desc: 'A self-taught cultivator with no sect, no backing, and no room in their storage ring for anything non-essential. Currently mid-Foundation Building — painfully aware of how far behind same-stage sect disciples they are in resources and technique quality. Compensating with caution, adaptability, and a working knowledge of every black market between here and the frontier.'
                },
                {
                    value: 'Inner Sect Disciple', specialRequests: 'Include inter-sect political rivalry, a forbidden cultivation art the protagonist has accidentally accessed, and the sect\'s concealed agenda that even senior disciples are kept ignorant of.',
                    alignment: 'Lawful Neutral', interests: 'Sword cultivation, pill identification, restricted archive research',
                    npcHints: 'A fellow inner disciple (rival-turned-ally dynamic), a sect elder who took an unusual interest in the protagonist early on (motives still unclear), a disciple from a rival sect whose path keeps inconveniently crossing the protagonist\'s',
                    appearance: 'Sect robes over a honed cultivator\'s frame, a flying sword worn at the back, the careful posture of someone trying not to attract the wrong kind of senior attention — not entirely successfully.',
                    desc: 'An inner disciple of one of the three great sects — talented enough to matter, not senior enough to be trusted with the things that actually matter. Recently accessed something in the restricted archive that the elders clearly went to considerable effort to bury.'
                },
                {
                    value: 'Fallen Prodigy', specialRequests: 'Include a destroyed cultivation base being rebuilt from scratch via an unorthodox path, former allies waiting to deliver a final kick, and a hidden reason why the talent was suppressed in the first place.',
                    alignment: 'Chaotic Neutral', interests: 'Pill refinement, formation theory, obscure texts on unusual cultivation paths',
                    npcHints: 'The one person who didn\'t leave (a loyal servant or companion), the rival who orchestrated or benefited from the fall (the face of the enemy), an eccentric hermit elder who sees something in the ruined cultivation base that everyone else missed',
                    appearance: 'The frame of someone who was a prodigy — still carries the posture. Looks like someone recovering from a long illness, which is not entirely inaccurate.',
                    desc: 'Once the most talented disciple in the clan — cultivation base destroyed overnight by an incident no one will explain, spiritual roots apparently severed, position stripped entirely. The people who mattered have turned away. Rebuilding from zero via an unorthodox path, with the added complication that whatever the incident left behind does not behave like a destroyed cultivation base should.'
                },
                {
                    value: 'Transmigrator · Hard', specialRequests: 'No cheat skill. The protagonist arrives as a mortal with no spiritual roots, no cultivation base, and no understanding of the cultivation world. In a realm where a low-level cultivator can flatten a mortal without noticing, being powerless is actively dangerous.',
                    alignment: 'Chaotic Good', interests: 'problem-solving, research, optimization',
                    npcHints: 'A mortal or low-level cultivator who provides the first foothold (the survival anchor), a cultivator who keeps noticing that the protagonist\'s reasoning is structurally alien (threat or future ally), an eccentric pill master or formation scholar who values unconventional thinking over spiritual roots',
                    appearance: 'Completely out of place — T-shirt, jeans, dead phone. In a cultivation world, even the clothes are impossible to explain.',
                    desc: 'A regular modern person, dropped into a cultivation world with no golden finger, no spiritual roots, and no cultivation base — just a functional brain and the dawning realization that most of what keeps a person alive here requires qi they will never naturally produce. Currently trying not to walk into a qi spillover and die.'
                },
                {
                    value: 'Transmigrator · Standard', specialRequests: 'Give the protagonist 1–2 abilities that are genuinely unusual in a cultivation context but provide no immediate power advantage. The ability should affect the growth ceiling, not the starting floor. Good examples: the ability to perceive and perfectly memorize the structural pattern of any cultivation technique they observe (requires actual spiritual foundation to execute — knowing the map is not the same as walking the road), a low-grade system that offers cultivation guidance and technique analysis but grants no stat bonuses or direct power, or a dormant bloodline that is completely inert until a specific cultivation stage is reached. The protagonist starts as a mortal or with low-grade spiritual roots and can genuinely struggle, fail, and depend on others. The significance of the cheat should be something felt in retrospect — visible in the growth curve over time — not something that solves problems in the opening scenes.',
                    alignment: 'Chaotic Good', interests: 'pattern recognition, optimization, research',
                    npcHints: 'A mortal, low-stage cultivator, or sect peer who helps the protagonist survive the early stretch (genuine bond, formed before any power gap opens), a cultivation scholar or eccentric elder who notices the protagonist\'s technique comprehension is structurally unusual, a genuine threat the protagonist cannot yet overcome — requiring creative use of the limited edge to survive',
                    appearance: 'Completely out of place — T-shirt, jeans, dead phone. Nothing marks them as a cultivator, or as someone who belongs in this world at all.',
                    desc: 'A regular modern person who arrived in a cultivation world with one or two quietly unusual abilities that provide no immediate advantage — only a different ceiling. The early cultivation journey involves real vulnerability, real setbacks, and real reliance on others. The difference from a standard cultivator is invisible at the start. It becomes harder to ignore over time.'
                },
                {
                    value: 'Transmigrator · Overpowered', specialRequests: 'Include a system interface with multiple cheat functions (technique library access, instant cultivation comprehension, hidden stat bonuses), a top-tier Heaven-grade spiritual root that activates on arrival, a spatial storage ring with starting resources and several starter techniques, and an auto-translation function. The power compounds rapidly — within months, the protagonist\'s cultivation speed is an open secret.',
                    alignment: 'Chaotic Good', interests: 'gaming, optimization, min-maxing',
                    npcHints: 'An opposite-sex companion from before the power spike (genuine bond, not power-attracted), a local genius who realizes the protagonist\'s advancement rate defies all known cultivation theory, a major sect or faction that decides the protagonist needs to be brought under control — one way or another',
                    appearance: 'Arrived in modern clothes. Now wears whatever the system flagged as highest-tier available. A spiritual root assessment that made the examiner recheck the testing array twice.',
                    desc: 'A regular modern person who arrived in a cultivation world with a full system interface, an instant language pack, a storage ring loaded with starter resources, and a Heaven-grade spiritual root the local testing array was not designed to measure. The sect prodigies are grinding their cultivation. The protagonist is reading system notifications. The gap has not yet become everyone\'s problem — but it will.'
                },
                {
                    value: 'Reincarnated Villain', specialRequests: 'The novel\'s chosen protagonist exists in this world — a Heaven\'s Favored talent whose cultivation arc ends with personally killing the villain the protagonist now inhabits. Include the villain\'s canonical death scene (remembered in precise detail), the faction entanglements the villain was born into, and the shrinking window before the protagonist\'s arc reaches this character.',
                    alignment: 'Chaotic Neutral', interests: '(Past life) cultivation web novels; (this life) staying alive, gathering intelligence, and not dying the same way twice',
                    npcHints: 'The Heaven\'s Favored protagonist — a rising talent whose arc is on a direct collision course with this body\'s life, the villain faction\'s most devoted follower (the one most likely to notice the change), a neutral elder who observes both sides of the coming conflict without committing to either',
                    appearance: 'The villain\'s sharp, striking face — the kind that ends up in readers\' mental images of the story. Not a face built for laying low.',
                    desc: 'Died and woke up as the primary antagonist of a cultivation web novel — with a clear, detailed memory of how this body\'s story ends. The Heaven\'s Favored protagonist is out there in their origin arc. Has somewhere between three and five cultivation stages before they become genuinely unkillable. The clock is running.'
                },
            ]
        },
        {
            id: 'space_opera',
            label: 'Hard Sci-Fi',
            genre: 'Hard Sci-Fi / Solar System Colonization',
            tone: 'Gritty, Realistic, Political — no aliens, no FTL',
            setting: 'Two hundred years from now, humanity has colonized the solar system but fractured into three hostile blocs: a declining Earth bureaucracy, a militaristic Mars Republic forged on discipline and sacrifice, and the Belters — asteroid-belt workers exploited by both inner planets, speaking their own creole and fighting for survival. No aliens, no faster-than-light travel. Physics matters. A mysterious event at the edge of the system threatens to ignite a war that none of the three factions can afford — and everyone suspects a different culprit.',
            identities: [
                {
                    value: 'Belter Crew', specialRequests: 'Emphasize resource scarcity, zero-g combat, Belter political consciousness, and morally grey factions. No alien life.',
                    alignment: 'True Neutral', interests: 'Zero-g ship maintenance, systems operation, Belter music',
                    npcHints: 'An opposite-sex crewmate whose fate becomes entangled with the protagonist\'s, a Belter political organizer with complicated motives (ally or liability), an inner-planet operative navigating the Belt\'s grey zones',
                    appearance: 'Tall and lean from low gravity, skin marked by years of recycled UV, slight skeletal differences visible at the wrists and jaw — built by the Belt, not a planet.',
                    desc: 'A Belt-born ship crew member in their 30s — lean from low gravity, lungs scarred by recycled air. Pragmatic and direct. Grew up resenting both Earth and Mars, but has learned that simple hatred doesn\'t keep you alive.'
                },
                {
                    value: 'Martian Marine', specialRequests: 'Emphasize military culture, moral disillusionment with the Republic, and the political machinery grinding behind the coming war. No alien life.',
                    alignment: 'Lawful Neutral', interests: 'Military tactics, weapons maintenance, physical conditioning',
                    npcHints: 'An opposite-sex Belter contact (cultural friction that becomes something more), a former commanding officer whose orders are increasingly hard to follow, a civilian caught between three powers who changes the protagonist\'s perspective',
                    appearance: 'Dense and compact from Martian gravity training, close-cropped military cut, the economical movement of someone who has run thousands of drills.',
                    desc: 'A recently discharged Marine Corps veteran who served two tours in the Belt. Disciplined, effective, and no longer sure the Republic they bled for deserves the loyalty.'
                },
                {
                    value: 'Earth Inspector', specialRequests: 'Emphasize bureaucratic conspiracy, evidence arranged to implicate the wrong parties, and the danger of being the one who notices. No alien life.',
                    alignment: 'Lawful Neutral', interests: 'Data analysis, reading political signals, encrypted communications',
                    npcHints: 'An opposite-sex local contact who offers help for reasons of their own, a bureaucratic superior who is probably complicit (or being used), a silencing operative who already knows the protagonist is asking the wrong questions',
                    appearance: 'Well-maintained professional appearance that\'s been subtly rumpled by the outer-planet assignment — the suit looks wrong past the asteroid belt.',
                    desc: 'A UN bureaucracy inspector sent to audit outer-planet operations. Politically savvy, personally compromised, and increasingly certain that the numbers in these reports have been arranged to point at the wrong people.'
                },
                {
                    value: 'Independent Contractor', specialRequests: 'Emphasize survival economics, secrets in cargo manifests, and the dangers of working in the grey zone between three hostile powers. No alien life.',
                    alignment: 'Chaotic Neutral', interests: 'Ship maintenance, navigation, cargo brokering',
                    npcHints: 'A passenger hiding something significant (the secret is bigger than expected), a shady cargo broker who keeps the work flowing (motivations opaque), a three-faction operative who needs the protagonist\'s ship and won\'t take no for an answer',
                    appearance: 'Practical, lived-in look — a pilot\'s jacket with too many pockets, short nails, hands that do their own repairs.',
                    desc: 'A freelance pilot who works for whoever pays — hauling cargo, running passengers, occasionally not asking what is in the containers. Operates a small ship and a smaller profit margin.'
                },
            ]
        },
        {
            id: 'galactic_opera',
            label: 'Space Opera',
            genre: 'Space Opera / Sci-Fi',
            tone: 'Epic, Adventurous, Mythic — with alien civilizations and FTL travel',
            setting: 'A vast galactic civilization spanning thousands of star systems, held together by a crumbling interstellar republic. Dozens of alien species coexist — some ancient and inscrutable, others newly spacefaring and hungry for recognition. FTL travel through hyperspace connects the core worlds, but the frontier remains lawless. A power vacuum following the assassination of the Republic\'s Chancellor has sent shockwaves through every faction: old imperial remnants smell blood, a monastic order of Force-sensitives fractures between tradition and radicalism, and a scrappy rebel coalition tries to hold the center. The protagonist is caught in the middle.',
            identities: [
                {
                    value: 'Starship Crew', specialRequests: 'Include diverse alien species, Force-like mystical powers, starship combat, and the tension between order and freedom.',
                    alignment: 'Chaotic Good', interests: 'Weapons systems, star charts, alien cultures',
                    npcHints: 'A crewmate (each carrying a distinct secret), a captain or employer with a layered agenda (ally or liability depending on the job), a nemesis or imperial agent who turns out to share an unexpected common ground',
                    appearance: 'Quick-moving and adaptable-looking, scuffed jacket, a utility belt with more gear than seems necessary — fully at home in zero-g.',
                    desc: 'A starship crew member in their late 20s — quick-witted, decent in a fight, and deeply uncomfortable with just following orders. Has a habit of ending up at the center of things they were never supposed to be involved in.'
                },
                {
                    value: 'Force Adept', specialRequests: 'Include the fractured Order, the protagonist\'s struggle with control, and multiple factions — some benevolent, some dangerous — seeking to recruit or suppress them.',
                    alignment: 'Chaotic Good', interests: 'Meditation, weapons technology, interstellar navigation',
                    npcHints: 'A trusted non-sensitive partner who keeps the protagonist grounded (pragmatic counterweight), a recruiter or hunter from within the fractured Order (ambiguous intent), an Imperial squad commander assigned to eliminate sensitives',
                    appearance: 'Quiet presence, slightly too-intense gaze, plain frontier clothes with no Order insignia — goes still in a way that occasionally makes people uncomfortable.',
                    desc: 'A partially-trained sensitive who fled the fractured Order before completing their trials. The ability is real; the control is inconsistent. Currently keeping a low profile on the frontier.'
                },
                {
                    value: 'Rebel Fighter', specialRequests: 'Include the internal divisions of the resistance coalition, frontline action, and the moral complexity of fighting for a cause that is right in principle but flawed in practice.',
                    alignment: 'Neutral Good', interests: 'Tactical study, galactic politics, weapon repair',
                    npcHints: 'A fellow fighter (mutual reliance born of shared danger), a commander the protagonist deeply respects but whose decisions are becoming harder to justify, a principled enemy soldier whose path keeps crossing the protagonist\'s (potential ally)',
                    appearance: 'Combat-worn gear, resistance coalition insignia, the look of someone who sleeps light and wakes fast.',
                    desc: 'A dedicated member of the resistance coalition — idealistic enough to still believe in the cause, experienced enough to know most of the leadership is making it up as they go.'
                },
                {
                    value: 'Imperial Defector', specialRequests: 'Include the protagonist\'s insider knowledge as a double-edged sword: invaluable to allies, a constant target for enemies, and a source of guilt that shapes every decision.',
                    alignment: 'True Neutral', interests: 'Military intelligence analysis, old Imperial history, weapons technology',
                    npcHints: 'A suspicious rebel opposite-sex who refuses to trust the defector at first (arc of earned trust), an Imperial hunter who knows the protagonist\'s history in forensic detail, a grey-zone shelter provider who asks for favors in return (each with their own calculation)',
                    appearance: 'The former Imperial officer\'s bearing doesn\'t disappear with civilian clothes — straight spine, precise movements, an expression that gives nothing away.',
                    desc: 'A former Imperial officer who switched sides after witnessing atrocities they could not rationalize away. The Rebellion needs their inside knowledge. They need to believe their past can be balanced.'
                },
            ]
        },
    ],
    zh: [
        {
            id: 'sword_magic',
            label: '劍與魔法',
            genre: '高奇幻',
            tone: '史詩、黑暗、政治陰謀',
            setting: '一個中世紀奇幻王國，北方沉眠的古老邪惡正在甦醒。魔法稀有且受強大法師公會管制，貴族派系與教會勢力競相爭奪王位影響力。',
            identities: [
                {
                    value: '冒險者', specialRequests: '',
                    alignment: '絕對中立', interests: '武器保養、探索廢墟、打聽情報',
                    npcHints: '可靠的異性搭檔（有隱情）、委託背後的神秘幕後人、與主角競爭同份任務的對手',
                    appearance: '三十出頭，身形精瘦偏結實，臉上有幾道淡淡的舊傷疤，髮型俐落——整體外觀普通到很容易被人忘記，這一點很有用。',
                    desc: '三十出頭、能力不俗但毫不起眼的冒險者，劍術過人，也有足夠的閱歷知道何時該逃。沒有什麼偉大命運，只是為了討生活。最近為了一個報酬豐厚的傳聞剛抵達王都。'
                },
                {
                    value: '騎士', specialRequests: '',
                    alignment: '守序中立', interests: '劍術訓練、騎乘、紋章學',
                    npcHints: '知情的侍從或侍女、主角效忠的主公（秘密持有者）、敵對騎士或政敵',
                    appearance: '高挑筆直，訓練有素的站姿，留著貼臉的短髮，長期戶外活動留下的膚色。',
                    desc: '效忠一個小貴族家族的中階騎士。忠誠、紀律嚴明，暗自察覺自家主人正在涉及一些不該碰的事。'
                },
                {
                    value: '公會法師', specialRequests: '',
                    alignment: '中立善良', interests: '魔法理論研究、藥草收集、星相觀測',
                    npcHints: '才華橫溢的異性同僚（個性複雜）、對主角戒心十足的公會監察者、田野任務的委託人（實為陰謀棋子）',
                    appearance: '身形偏纖細，指頭常有墨漬，眼神敏銳而偶爾有些發散，頭髮習慣紮起，總是快要散掉。',
                    desc: '持有法師公會執照的見習法師——才能足以通過考核，背景不夠深厚以快速晉升。接野外任務是為了補貼研究材料的費用。'
                },
                {
                    value: '傭兵', specialRequests: '',
                    alignment: '混亂中立', interests: '武器交易、地圖收集、賭博（偶爾）',
                    npcHints: '長期合作的異性搭檔、黑市情報中間人（任務來源）、來自過去的宿敵（知道主角弱點）',
                    appearance: '身材壯實偏矮，三十多歲，身上有大大小小的舊傷，站著的樣子像是隨時準備扭頭就走的人。',
                    desc: '沒有效忠對象的老兵，履歷表上滿是完成的合約，說的是活下來，不是什麼榮耀。目前無工可接，錢包見底。'
                },
                {
                    value: '穿越者・困難', specialRequests: '無任何外掛。主角帶著自己的身體和現代衣物出現，在一個以魔法論尊卑的世界裡毫無能力，沒有魔法天賦，也沒有任何加成。',
                    alignment: '混亂善良', interests: '解決問題、歷史、煮飯',
                    npcHints: '收留主角的異性本地人（生存支柱）、一直覺得主角思維方式很奇怪的本地人（後期盟友或威脅）、因為主角不靠魔法的解題方式而感到意外的法師學者',
                    appearance: '完全就是個現代人——牛仔褲、外套、運動鞋，手機沒電。放在這個世界裡格格不入。',
                    desc: '穿越前是個普通的現代人，不明原因被丟進中世紀奇幻世界，沒有外掛、沒有魔法親和力。每天存活都是問題。唯一能用的是一個正常運作的腦子——在這個世界裡，這個排在能放火球的後面。'
                },
                {
                    value: '穿越者・標準', specialRequests: '給予主角1至2個真實存在但無法立刻帶來戰鬥優勢的異常能力。能力應該改變成長天花板，而非提升起始下限。適合的例子：觀察或認真研習過一次的任何魔法都能完整記住（但仍需魔力親和力和練習才能施展——知道地圖不等於走過了路）、只提供知識鑑定和資訊卻不加屬性的低階系統、一個要到達特定條件才會覺醒的沉眠天賦。主角在初期仍然真實脆弱，可以有真正的危機、挫折和依賴他人的場景。外掛的意義應該是在成長曲線的回顧中才看得出來，不是在開場就用來解決問題的。',
                    alignment: '混亂善良', interests: '識別規律、解決問題、適應新環境',
                    npcHints: '在優勢還沒顯現前幫助主角的異性本地人（力量差距打開前建立的真實情誼）、注意到主角學習魔法的方式有點不對勁而開始追問的法師或學者、目前主角力量應付不了的威脅——只能靠有限的優勢想辦法繞過去',
                    appearance: '完全就是個現代人——T恤、牛仔褲、運動鞋，手機沒電。放在這個世界裡格格不入。',
                    desc: '穿越前是個普通的現代人，帶著一兩個悄悄不尋常的能力被丟進這個世界——不足以橫行霸道，卻足以讓軌跡走向不同。早期仍然在掙扎、求人幫忙、以疼痛的方式失敗。那個差異還沒有對任何人顯現出來。'
                },
                {
                    value: '穿越者・龍傲天', specialRequests: '包含帶有至少兩個主動外掛功能的系統面板（例如萬能鑑定、技能複製、加速學習）、抵達時覺醒的頂級隱藏魔法親和力，以及一個裝了基礎補給的空間戒指。外掛效果疊加——幾週內，成長曲線就開始無法解釋。',
                    alignment: '混亂善良', interests: '打遊戲、搞優化',
                    npcHints: '在力量爆發前就認識的異性夥伴（真實情感，不是被強大吸引的）、開始注意到主角不可能的成長速度的本地天才、決定要招攬或除掉主角的大勢力',
                    appearance: '穿著現代衣服抵達，現在穿著系統標記為「最優掉落」的裝備。公會測定的魔法親和力讓測定員重新測了三次。',
                    desc: '穿越前是個普通的現代人，抵達中世紀奇幻世界時卻帶著完整系統面板、兩個初始技能、一個空間戒指，以及公會評級表格裝不下的魔法親和力。本地天才們在拚命刻苦。主角在跟著系統通知走。差距還沒人全部注意到。'
                },
                {
                    value: '轉生貴族', specialRequests: '加入外掛技能，以及圍繞主角所在貴族家族的政治鬥爭。主角對家族陰謀最終走向有預知。',
                    alignment: '守序善良', interests: '（前世）讀輕小說；（此世）家族政治、馬術',
                    npcHints: '政治聯姻對象（對主角暗生情愫）、見過「換人」前後差異的忠心隨從、原劇本中的主要反派（目前尚未現身）',
                    appearance: '貴族少爺的臉和體型——保養得宜，手掌細嫩。整具身體跟目前在裡面的那個腦子完全對不上。',
                    desc: '醒來發現自己佔據了一個小貴族少爺的身體，前世記憶完整保留。隱約記得這個世界的「劇情走向」——以及原主角色的結局有多難看。'
                },
                {
                    value: '召喚勇者', specialRequests: '加入外掛技能、預言的重量，以及各勢力爭奪勇者效忠的角力。',
                    alignment: '中立善良', interests: '（前世）打遊戲；（此世）適應中',
                    npcHints: '奉命護送勇者的異性騎士或賢者、暗中利用勇者的神官或王族代理人、以勇者為目標的強敵（可能成為盟友）',
                    appearance: '普通現代人的體格，被召喚過來的時候還穿著當天早上的衣服。',
                    desc: '被王國儀式從現代世界召喚過來，當場被宣告為預言中的勇者。眾人的期待已經壓上來了，配得上那個頭銜的自信還沒跟上。'
                },
                {
                    value: '轉生反派', specialRequests: '一位命中注定的宿敵存在於這個世界——一個正在崛起的英才，其命運軌跡直指主角。加入死亡flag以及反派試圖在劇情追上自己之前改寫命運的掙扎。',
                    alignment: '混亂中立', interests: '（前世）讀輕小說；（此世）情報收集、延命',
                    npcHints: '命中注定會找上主角的年輕英才（正值覺醒期）、反派陣營最忠心的手下（唯一知曉內情的人）、見證主角「異常行為」而起疑的第三方',
                    appearance: '反派的那種稜角分明的外貌——讓人記住，又說不清哪裡讓人想保持距離，笑起來更是。',
                    desc: '死後轉生成一部自己只讀了一半的輕小說裡的反派角色。主角和他的主角光環就在某個地方。死亡flag需要拆除，越快越好。'
                },
            ]
        },
        {
            id: 'cyberpunk',
            label: '賽博龐克',
            genre: '賽博龐克 / 近未來科幻',
            tone: '粗獷、黑色電影、高科技低生活',
            setting: '2077年，被三大競爭巨型企業統治的霓虹大都市。富裕精英住在霧霾線以上的閃亮穹頂城，而大多數人在下層掙扎求生。賽博義體改造廉價且普遍。',
            identities: [
                {
                    value: '傭兵', specialRequests: '包含黑市科技、地下抵抗組織和企業間諜主題。',
                    alignment: '混亂中立', interests: '武器改裝、地下搏擊、黑市掃貨',
                    npcHints: '可靠的異性搭檔（有隱情）、提供情報和任務的神秘中間人、追殺主角的企業傭兵頭目',
                    appearance: '精瘦身形，捲起的袖口下可以看見義體強化的手臂，太陽穴有幾個金屬介面，動作帶著節省力氣的習慣性放鬆。',
                    desc: '二十多歲的自由傭兵，身手矯健，口袋裡的錢隨時可能見底。裝了基本戰鬥義體，以不多問、能辦事聞名。在下城區接活維生。'
                },
                {
                    value: '駭客', specialRequests: '包含黑市科技、企業資料庫，以及ICE（入侵對抗電子裝置）的致命風險。',
                    alignment: '混亂善良', interests: '系統破解、黑市軟體收集、地下音樂',
                    npcHints: '現實世界的聯絡人（提供庇護和資源）、有用的企業內線（動機複雜）、追蹤主角的企業ICE獵手',
                    appearance: '長期盯著螢幕的蒼白膚色，後頸有神經介面插孔，穿著那種穿了很久沒換的舒適舊衣。',
                    desc: '在狹小公寓裡靠一副偷來的神經介面活動的網路駭客。從任何地方抓資料都行，要讓人付錢才是難題。目前欠了不該欠的人一個人情。'
                },
                {
                    value: '企業職員', specialRequests: '包含企業間諜、告密者困境，以及知道太多的人會面臨的存亡危機。',
                    alignment: '守序中立', interests: '數據分析、企業政治觀察、高級餐廳',
                    npcHints: '同樣知道太多的異性同僚（同病相憐）、地下抵抗組織的接頭人（想利用主角情報）、讓主角噤聲的上司或對手',
                    appearance: '撐過壓力之後仍維持的整潔職場外觀——熨好的套裝、疲憊的眼睛、一個練習出來的得體微笑。',
                    desc: '某巨型企業的中階白領——取得的權限高到足以看見不該看的東西，卻還沒有高到不會被滅口。計時器已經開始倒數。'
                },
                {
                    value: '街頭醫生', specialRequests: '包含黑市義體、地下抵抗網絡，以及替衝突各方的人縫針所帶來的道德困境。',
                    alignment: '中立善良', interests: '非法醫學研究、黑市藥品、地下音樂',
                    npcHints: '常客（重傷的線人或前幫派成員）、想利用主角資源的幫派頭目、帶來麻煩的重傷委託人（身份特殊）',
                    appearance: '雙手穩而快，醫療包從不離手，是那種在嘈雜現場做過緊急處置才有的眼神。',
                    desc: '替正規診所會舉報的人縫針的地下醫生。在三個幫派、兩個地下抵抗組織、一個極度緊張的企業叛逃者那裡都有聯絡人。'
                },
            ]
        },
        {
            id: 'wuxia',
            label: '武俠江湖',
            genre: '武俠 / 歷史奇幻',
            tone: '快意恩仇、榮辱義氣、陰謀詭計',
            setting: '盛唐至北宋年間，繁華盛世下暗潮洶湧的江湖。朝廷、佛門、道家與各大武林門派之間勢力交錯。一件與傳說中開派宗師相關的失傳遺物重現江湖，引發一場波及廟堂與草野的血腥爭奪。',
            identities: [
                {
                    value: '江湖劍客', specialRequests: '包含獨門內功心法、江湖恩怨糾葛，以及一個牽涉朝廷與多方勢力的核心謎團。',
                    alignment: '混亂善良', interests: '劍道研究、品茗、探訪武林遺跡',
                    npcHints: '命運糾纏的異性（醫者或名門後裔）、仇家後裔（宿敵，也可能成為盟友）、亦正亦邪的謎樣高人（知道更多真相）',
                    appearance: '精瘦靈活，二十出頭，素色行旅衣，劍背在背上的姿勢自然不做作，習慣把進出的人都掃一遍。',
                    desc: '二十出頭、無門無派的江湖劍客。師從一位帶著未竟秘密辭世的隱居高人，武藝出眾、行事有所堅守，身上背著一筆仇，但仇的全貌尚未清晰。'
                },
                {
                    value: '門派弟子', specialRequests: '包含門派間的角力、武林比試背後的隱秘目的，以及師門正在秘密傳承的獨門功法。',
                    alignment: '守序善良', interests: '武功鑽研、門派典籍閱覽、比武切磋',
                    npcHints: '知曉師門秘密的異性師兄妹、外門派的強勁對手（尊重對手的那種）、掌握武林格局的神秘前輩',
                    appearance: '門派制服，站姿端正，常年練武留下的強健雙手，臉比眼神年輕。',
                    desc: '一個中型門派的弟子，被師門寄予武林比試的厚望，暗自懷疑掌門對這場比試的真正用意另有隱情。'
                },
                {
                    value: '捕頭', specialRequests: '包含廟堂政治與江湖勢力的糾纏、嫌疑人過多的懸案，以及來自上方要求盡快結案的壓力。',
                    alignment: '守序中立', interests: '案件研究、江湖人物誌收集、弓術',
                    npcHints: '協助破案的異性線人（江湖人或知情者）、案件背後的主要嫌疑人（動機複雜）、上司背後勢力的代言人（施壓主角）',
                    appearance: '樸素的官差袍，打扮實用不講裝飾，腰帶掛著令牌，眼神沉穩。',
                    desc: '效力於朝廷緝捕局的低階捕頭，專門被派去接旁人不願碰的棘手案子。'
                },
                {
                    value: '儒俠', specialRequests: '包含廟堂禮法與江湖規矩的衝突、秘而不宣的武學傳承，以及兩個世界都可能危及主角的政治風險。',
                    alignment: '守序善良', interests: '詩詞書法、武學理論、茶道',
                    npcHints: '廟堂出身的異性（才女或命婦）、武林中仗義的盟友（老江湖）、廟堂或江湖任一方的主要對手',
                    appearance: '書生長袍套著意外結實的身形，指頭沾著墨，腰間的劍帶和整體穿著不太搭，這是刻意的。',
                    desc: '暗中習武的舉人，在廟堂文人與江湖草莽之間兩頭走，哪邊都踩不穩。'
                },
                {
                    value: '穿越者・困難', specialRequests: '無任何外掛。主角帶著自己的身體和現代衣物出現，從第一秒起就格格不入，沒有武功基礎，也沒有修煉，在一個功夫和修為決定生死的世界裡幾乎毫無自保能力。',
                    alignment: '混亂善良', interests: '歷史、美食、刷短影片',
                    npcHints: '異性本地引路人（醫者或江湖俠客）、對主角衣著言行深感懷疑的本地人（後期可能成為盟友）、能帶主角進入江湖的義人',
                    appearance: '現代人——T恤、牛仔褲、手機在口袋。沒有一樣東西符合時代，什麼都需要解釋。',
                    desc: '穿越前是個普通的現代人，一眨眼發現自己站在唐宋年間一個村莊邊緣——還穿著現代衣物，手機沒電，完全不知道是怎麼來的。不是借屍還魂，是本人直接被丟到這裡。沒有武功、沒有修煉，眼下最急的問題是解釋自己身上這套衣服。'
                },
                {
                    value: '穿越者・標準', specialRequests: '給予主角1至2個在武學脈絡下真實存在但無法立刻帶來戰鬥優勢的異常能力。能力應該抬高成長天花板，而非提升起始下限。適合的例子：完美的肌肉記憶（正確練習過一次的功法永久記住，但身體仍需扎實訓練才能高速施展——記憶和能耐是兩回事）、被動的殺意感知（能感應到殺機，但不提供任何戰鬥加成）、提供修煉分析和功法指引卻不加屬性的低階系統。主角在初期沒有武力，可以被真實威脅到。外掛的價值在於它所創造的上限，不是它提供的下限——武林前輩事後回看主角的成長曲線才會覺得不對，而不是第一天見面就認出來。',
                    alignment: '混亂善良', interests: '歷史、觀察、識人',
                    npcHints: '在能力證明自身之前幫助主角的異性江湖人（真實情誼，不是被強大吸引的）、注意到主角的功法學習曲線和他的江湖資歷明顯對不上的前輩、目前主角克服不了的威脅——迫使他用有限的優勢繞過去，而不是正面硬槓',
                    appearance: '現代人——T恤、牛仔褲、手機在口袋。沒有一樣東西符合時代，什麼都需要解釋。',
                    desc: '穿越前是個普通的現代人，帶著一兩個今天不會讓他危險、但最終會讓他與眾不同的悄悄異常能力被丟進了江湖。仍然需要真正的努力、真正的危機，以及他人真正的幫助。和別人的差別在軌跡，不在起點——而且那個軌跡目前還看不出來。'
                },
                {
                    value: '穿越者・龍傲天', specialRequests: '包含帶有外掛功能的系統（武學圖書館、即時內功理解、體質強化加成）、抵達時覺醒的頂級武學根骨，以及裝有補給和幾門初始功法的隨身空間袋。主角從零開始，但幾個月內成長速度就會引起警覺。',
                    alignment: '混亂善良', interests: '打遊戲、讀武俠',
                    npcHints: '在力量爆發前就認識的異性江湖人（真實情誼，不是被強大吸引的）、注意到一個師弟修煉速度打破所有已知記錄的宗門長老、試圖把主角在做的事鎖定起來的江湖勢力',
                    appearance: '穿著現代衣服抵達，後來換上了江湖裝束。鑑定根骨時，負責鑑定的前輩重複了兩次。',
                    desc: '穿越前是個普通的現代人，穿越到唐宋修煉世界後卻帶著系統面板、即時語言包、一袋初始資源，以及系統標注為「天階武學根骨」的東西。原著主角正在刻苦磨練自己的出身篇。新來的人已經超前三步了。'
                },
                {
                    value: '轉生書生', specialRequests: '強調歷史預知與已然偏移的時間線之間的張力。主角可能親手造成——或無力阻止——自己以為早已知曉的事。',
                    alignment: '守序中立', interests: '（前世）歷史研究；（此世）觀察時間線偏移',
                    npcHints: '對主角不尋常見識深感好奇的異性（才女或名士之後）、主角在朝廷的上司或政敵（歷史重要人物）、偏離原本走向的關鍵歷史人物',
                    appearance: '低階文官的袍服，手指沾墨，一張放在古代臉孔裡的現代眼神。',
                    desc: '現代歷史學者醒來成了唐宋年間的一名低階文官。對歷史走向瞭若指掌——這件事恐怖就恐怖在時間線已經開始悄悄偏移。'
                },
                {
                    value: '轉生反派', specialRequests: '一位命中注定的宿敵存在於這個世界——一個正在崛起的英才，其命運軌跡直指主角。加入反派的「正典死亡」作為懸在頭上的命運，以及反派牽涉其中的派系糾葛。',
                    alignment: '混亂中立', interests: '（前世）讀武俠；（此世）情報收集、延命計畫',
                    npcHints: '命中注定會找上主角的才華橫溢年輕劍客（正值崛起）、反派陣營核心手下（對主角忠心耿耿）、知曉反派身份的旁觀者（威脅或潛在盟友）',
                    appearance: '反派那種讓人難以看透的外貌——輪廓稜角，習慣被人盯著，笑的時候很難說哪裡讓人不安。',
                    desc: '死後轉生成自己半記得的武俠小說裡的陰謀反派。原著主角是個才華橫溢的年輕劍客，正以固定速度朝這具身體的死亡奔赴。時鐘在走。'
                },
            ]
        },
        {
            id: 'xuanhuan',
            label: '修仙玄幻',
            genre: '玄幻 / 修仙',
            tone: '機緣、爭鬥、逆天改命',
            setting: '一片以修為論尊卑的廣袤修仙大陸。修士按境界晉升——煉氣、築基、金丹、元嬰、化神乃至更高——每一次突破都是與天道的角力。三大宗門把持中原靈地，魔道隱宗潛伏於邊陲，上古仙魔大戰遺留的廢墟中珍寶與禁地並存。靈根決定命運——沒有資質的人，要麼另尋出路，要麼消失。',
            identities: [
                {
                    value: '散修', specialRequests: '包含無門派指引自行修煉的危險、黑市資源經濟體系，以及宗門弟子視散修為獵物的常態威脅。',
                    alignment: '絕對中立', interests: '廢墟探索、丹藥理論研究、陣法',
                    npcHints: '另一名散修（共患難的複雜信任關係）、知道哪裡有危險機緣的黑市聯絡人、把欺壓散修當消遣的宗門弟子——快要吃虧了',
                    appearance: '普通的行旅裝束，一枚見過好日子的儲物戒指，以及從來沒有睡過真正安全的地方才會有的那種永恆警覺眼神。',
                    desc: '沒有師門、沒有靠山、儲物戒指裡塞不下非必需品的自修士。目前築基中期——非常清楚自己在資源和功法品質上跟同境界的宗門弟子差了多遠。靠謹慎、應變能力和對沿路所有黑市的熟悉程度彌補差距。'
                },
                {
                    value: '宗門弟子', specialRequests: '包含宗門間的政治角力、主角意外接觸到的禁忌功法，以及連資深弟子都被蒙在鼓裡的師門隱秘圖謀。',
                    alignment: '守序中立', interests: '劍修、丹藥鑑定、禁區典籍研究',
                    npcHints: '同為內門弟子（競爭後轉為同盟的弧線）、很早就對主角表示出異常興趣的長老（動機至今不明）、路子老是不湊巧和主角交叉的外門派弟子',
                    appearance: '師門制服套著精煉過的修士身形，劍背在後，是那種試圖不引起錯誤類型的長老注意的小心站姿——不太成功。',
                    desc: '三大宗門之一的內門弟子——有才華到值得被在意，卻還沒資格知道真正重要的事。最近在禁區典籍中看到了一些長老顯然費了很大力氣去掩埋的東西。'
                },
                {
                    value: '廢材公子', specialRequests: '包含以非正統路徑從頭重建被毀的修為，等著補一腳的前昔盟友，以及天賦被壓制的真正原因。',
                    alignment: '混亂中立', interests: '煉丹、陣法理論、記載非常規修煉路徑的古籍',
                    npcHints: '唯一沒有離開的人（忠心隨從或同伴）、促成或受益於主角跌落的競爭者（敵人的臉）、在廢掉的修為裡看見別人都沒看見的東西的怪人長老或隱士',
                    appearance: '天才應有的形架——姿態還在。像一個剛從長期病中恢復的人，這個說法不完全是錯的。',
                    desc: '曾是家族最有天賦的弟子——一夜之間修為全毀，靈根據說已斷，身份一擼到底。過去有份量的人都轉身離開了。以非正統路徑從零重建，同時帶著一個額外的問題：那場事故留下的東西，不像一個真的毀掉的修為應有的反應。'
                },
                {
                    value: '穿越者・困難', specialRequests: '無任何外掛。主角以凡人身份抵達，沒有靈根、沒有修為、對修仙界一無所知。在一個低階修士就能順手把凡人打飛的世界裡，毫無力量就是實質上的危險。',
                    alignment: '混亂善良', interests: '解決問題、研究、搞優化',
                    npcHints: '提供第一個立足點的凡人或低階修士（生存支柱）、一直覺得主角的思維邏輯構造不對的修士（威脅或後期盟友）、以非正統思維方式取代靈根的怪人丹師或陣法師',
                    appearance: '完全格格不入——T恤、牛仔褲，手機沒電。在修仙界，光是那身衣服就難以解釋。',
                    desc: '穿越前是個普通的現代人，沒有金手指、沒有靈根、沒有修為地被丟進了修仙界——只有一個正常運作的腦子，以及對「這個世界大多數讓人活下去的東西都需要靈氣」這件事越來越強烈的體會。目前試圖不走進別人的靈氣溢散範圍裡送命。'
                },
                {
                    value: '穿越者・標準', specialRequests: '給予主角1至2個在修仙脈絡下真實存在但不提供即時戰鬥優勢的異常能力。能力應該改變成長天花板，而非提升起始下限。適合的例子：能夠感知並完整記憶任何觀察到的功法結構（需要真正的修煉基礎才能施展——知道地圖不等於走過了路）、提供修煉方向分析和功法解讀卻不加屬性、不直接贈送力量的低階系統、需要修至特定境界才會覺醒的完全沉眠血脈。主角以凡人或低階靈根起步，可以真實掙扎、真實失敗、真實依賴他人。外掛的意義應該是在回顧成長曲線時才看得出來的——不是開場就用來宣告身份的。',
                    alignment: '混亂善良', interests: '識別規律、搞優化、做研究',
                    npcHints: '在力量差距打開前幫助主角的凡人、低境界修士或同門（真實情誼）、注意到主角的功法理解方式在結構上不尋常的修煉學者或怪人長老、目前主角真正克服不了的威脅——迫使他用有限的優勢想辦法，而不是直接硬拚',
                    appearance: '完全格格不入——T恤、牛仔褲，手機沒電。沒有任何東西標示出修士的身份，或是屬於這個世界的任何跡象。',
                    desc: '穿越前是個普通的現代人，帶著一兩個不提供即時戰鬥優勢、只提供不同上限的悄悄異常能力被丟進了修仙界。修煉初期有真實的脆弱、真實的挫折和對他人的真實依賴。和普通修士的差異一開始是隱形的。隨著境界推進，它越來越難以忽視。'
                },
                {
                    value: '穿越者・龍傲天', specialRequests: '包含帶有多種外掛功能的系統面板（功法庫存取、即時修煉理解、隱藏屬性加成）、抵達時覺醒的頂階天靈根、裝有初始資源與幾門入門功法的空間儲物戒指，以及自動語言包。力量加速疊加——幾個月內，主角的修煉速度就成了公開的秘密。',
                    alignment: '混亂善良', interests: '打遊戲、搞最優化、算數值',
                    npcHints: '力量爆發前就認識的異性夥伴（真實情誼，不是被強大吸引的）、意識到主角的突破速度在所有已知修煉理論裡都找不到解釋的本地天才、決定要把主角納入掌控的大宗門或勢力',
                    appearance: '穿著現代衣物抵達。現在穿著系統標記為當前最高品階的裝備。靈根鑑定時，負責鑑定的修士把測試陣法重新激活了兩次。',
                    desc: '穿越前是個普通的現代人，帶著完整系統面板、即時語言包、裝了初始資源的儲物戒指，以及本地鑑定陣法設計時根本沒預留位置的天靈根抵達了修仙界。宗門天才們在拚命苦修。主角在跟著系統通知走。差距還沒成為所有人的問題——但快了。'
                },
                {
                    value: '轉生反派', specialRequests: '這個世界裡存在一位天命之子——一個天賦型修士，其修煉弧線終點就是親手殺死主角所在的這具身體。包含反派的正典死亡場景（主角記得清清楚楚）、反派身分帶來的派系糾葛，以及天命之子的弧線追上這裡之前越來越短的時間窗口。',
                    alignment: '混亂中立', interests: '（前世）讀修仙網文；（此世）活下去、收集情報、不以同樣的方式死第二次',
                    npcHints: '天命之子——一個正值崛起期、命運弧線直指主角這具身體的天才、反派陣營最忠心的手下（最可能注意到改變的人）、旁觀即將到來的衝突雙方卻不表態的中立長老',
                    appearance: '反派那種稜角分明的顯眼外貌——讀者腦海裡留得住的那種臉。不是一張適合蟄伏的臉。',
                    desc: '死後轉生成一部修仙網文的主要反派——對這具身體的結局有清晰、詳細的記憶。天命之子正在某處跑著他的出身篇。距離那個人真正無法被擊殺，中間還差三到五個境界。時鐘在走。'
                },
            ]
        },
        {
            id: 'space_opera',
            label: '硬科幻',
            genre: '硬科幻 / 太陽系殖民',
            tone: '寫實、殘酷、政治驅動——無外星人，無超光速',
            setting: '兩百年後，人類殖民了整個太陽系，卻分裂成三個對立勢力：腐化的地球聯合國政府、以紀律與犧牲鑄就的火星共和國，以及在小行星帶討生活、說著自己方言、被內太陽系雙方剝削的小行星帶工人（Belters）。沒有外星人，沒有超光速飛行，物理定律一視同仁。太陽系邊緣發生了一起神秘事件，三方各執一詞，一場無人承擔得起的全面戰爭正在逼近。',
            identities: [
                {
                    value: '帶工船員', specialRequests: '強調資源匱乏、零重力戰鬥、小行星帶工人的政治意識與道德灰色地帶。不出現任何外星生命。',
                    alignment: '絕對中立', interests: '零重力船艙維修、飛船系統操作、帶語音樂',
                    npcHints: '命運與主角糾纏的異性船員、動機複雜的帶工政治組織者（盟友或包袱）、在帶上穿梭的內太陽系勢力特工',
                    appearance: '低重力出身的高挑精瘦，皮膚帶著循環燈光長期照射的蒼白，手腕骨架略有外帶骨骼的特徵——是帶上養出來的身體，不是星球。',
                    desc: '三十多歲、在帶上出生的飛船船員——低重力讓身形精瘦，循環空氣早已在肺上留下痕跡。務實、直接。帶著對地球和火星的怨，但也明白純粹的仇恨養不活自己。'
                },
                {
                    value: '火星陸戰隊員', specialRequests: '強調軍隊文化、對共和國的幻滅，以及在戰爭機器背後運轉的政治操弄。不出現任何外星生命。',
                    alignment: '守序中立', interests: '軍事戰術、武器維護、體能訓練',
                    npcHints: '帶工出身的異性聯絡人（文化摩擦逐漸轉化為更多）、越來越難以服從的昔日指揮官、夾在三方之間的平民（改變主角視野）',
                    appearance: '火星重力訓練出的密實體格，寸頭，移動時帶著多年操練留下的精準感。',
                    desc: '剛退伍的火星陸戰隊老兵，在帶上服完兩期役。紀律嚴明、有效，只是越來越不確定自己流過血的那個共和國值不值得這份忠誠。'
                },
                {
                    value: '地球監察官', specialRequests: '強調官僚陰謀、被刻意指向錯誤對象的證據，以及成為那個注意到異常的人有多危險。不出現任何外星生命。',
                    alignment: '守序中立', interests: '數據分析、解讀政治信號、加密通訊',
                    npcHints: '出於自身理由提供協助的異性當地聯絡人、可能是同謀也可能是棋子的上司、已知主角在追查的滅口特工',
                    appearance: '外太陽系任務讓整潔的職場外觀略顯凌亂——那身衣服放在小行星帶以外的地方才對。',
                    desc: '被聯合國官僚機構派往外太陽系執行審計的監察官。政治嗅覺敏銳、個人把柄不少，也越來越確定這些報告裡的數字被刻意安排成指向錯誤的對象。'
                },
                {
                    value: '獨立承包商', specialRequests: '強調生存經濟學、貨艙清單裡藏著的秘密，以及在三個敵對勢力之間的灰色地帶討生活的代價。不出現任何外星生命。',
                    alignment: '混亂中立', interests: '飛船維護、航行、貨物仲介',
                    npcHints: '帶著重要秘密的乘客（秘密比預期的大得多）、讓工作持續進來的黑市貨物中間人（動機不明）、需要主角的船且不接受拒絕的三方特工',
                    appearance: '實用生活感的外觀——口袋太多的飛行員夾克，指甲剪得短，雙手是自己動手修船留下的樣子。',
                    desc: '為出錢的人駕船的自由飛行員——運貨、載客，偶爾不問艙裡裝的是什麼。開著一艘小船，維持著一個更小的利潤空間。'
                },
            ]
        },
        {
            id: 'galactic_opera',
            label: '星際歌劇',
            genre: '太空歌劇 / 科幻',
            tone: '史詩、冒險、神話感——有外星文明與超光速飛行',
            setting: '橫跨數千個星系的龐大銀河文明，由一個搖搖欲墜的星際共和國勉強維繫。數十個外星種族共存——有的古老深沉、難以揣摩，有的剛剛邁入宇宙、渴望被承認。超空間引擎連結核心星球，但邊疆地帶依舊法外橫行。共和國議長遭暗殺後，權力真空震動各方勢力：舊帝國殘黨蠢蠢欲動，一個培育原力感應者的修道教團在傳統與激進之間分裂，而一支雜牌叛軍聯盟正試圖撐起搖搖欲墜的秩序。主角被捲入其中。',
            identities: [
                {
                    value: '星艦船員', specialRequests: '包含多元外星種族、類原力神秘能力、星艦戰鬥，以及秩序與自由之間的張力。',
                    alignment: '混亂善良', interests: '武器系統、星圖研究、異星文化',
                    npcHints: '船上異性隊友（各有秘密）、船長或雇主（動機複雜，可能有隱藏目的）、宿敵或帝國特工（可能有意外的共同點）',
                    appearance: '動作快，適應力強的感覺，夾克有磨損，腰帶掛的工具比必要的多——在零重力環境裡的姿勢完全自然。',
                    desc: '二十多歲的星艦船員，反應快、打架還行，骨子裡對「服從命令」這件事深感不適。有一種莫名其妙總是被捲進完全不關自己的事的天賦。'
                },
                {
                    value: '原力感應者', specialRequests: '包含分裂的感應者教團、主角對能力的掌控掙扎，以及試圖招募或壓制他們的多方勢力——有的出於善意，有的則不是。',
                    alignment: '混亂善良', interests: '冥想、武器技術、星際航行',
                    npcHints: '信任的非感應者夥伴（務實平衡主角的思維）、教團中想拉攏或消滅主角的感應者、帝國獵殺小組的指揮官',
                    appearance: '沉靜的存在感，眼神偶爾有點太過專注，穿著邊疆區的素淨便服沒有任何教團標記——偶爾靜止的姿勢讓人不太自在。',
                    desc: '在完成試煉之前逃離分裂教團的半訓練感應者。能力是真的；控制力時好時壞。目前在邊疆低調行事。'
                },
                {
                    value: '叛軍士兵', specialRequests: '包含抵抗聯盟的內部矛盾、前線行動，以及為一個原則上正確、實踐上漏洞百出的事業而戰的道德複雜性。',
                    alignment: '中立善良', interests: '戰術研究、星際政治、修繕武器',
                    npcHints: '並肩作戰的異性隊友（彼此依賴）、令人尊敬卻決策可疑的指揮官、有原則的敵方士兵（潛在盟友）',
                    appearance: '作戰磨損的裝備，抵抗聯盟的徽章，是那種睡得很淺、醒得很快的人的樣子。',
                    desc: '抵抗聯盟的忠誠成員——理想主義留得夠多，還相信這件事值得做；閱歷也夠深，知道大部分領導層都在邊走邊想。'
                },
                {
                    value: '帝國叛逃者', specialRequests: '包含主角的內部情報作為雙刃劍：對盟友而言無可替代，對敵人而言始終是目標，對自己而言則是左右每一個決定的罪咎感。',
                    alignment: '守序中立', interests: '軍事情報分析、舊帝國歷史、武器技術',
                    npcHints: '抗拒信任主角的叛軍異性（後期轉變）、對主角過去如數家珍的帝國追殺者、提供庇護的灰色地帶人物（各有算盤）',
                    appearance: '換了平民服裝，帝國軍官的站姿和習慣卻沒跟著消失——脊背筆直，動作精準，表情刻意不透露任何資訊。',
                    desc: '目睹了無法自我說服的暴行之後倒戈的前帝國軍官。叛軍需要他們的內部情報，他們需要相信過去能夠被平衡。'
                },
            ]
        },
    ]
};
