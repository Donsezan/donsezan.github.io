const canvas = document.getElementById('war-room');
const ctx = canvas.getContext('2d');
const locationDisplay = document.getElementById('user-location');
const clockDisplay = document.getElementById('clock');

let width, height;
let mapData = [];
let userLat = 0, userLon = 0;
let missiles = [];
let explosions = [];
let units = [];
let targets = [];
let defcon = 5;
let gameStarted = false;
let defconInterval;
let victorySecured = false;

// DEFCON Levels
const DEFCON_LEVELS = {
    5: { text: "FADE OUT", color: "#00ff00" },
    4: { text: "DOUBLE TAKE", color: "#00ff00" },
    3: { text: "ROUND HOUSE", color: "#ffff00" },
    2: { text: "FAST PACE", color: "#ff9900" },
    1: { text: "COCKED PISTOL", color: "#ff0000" }
};

// Factions
const FACTIONS = {
    NA: { name: 'NORTH AMERICA', color: '#00f3ff', targets: [], assets: [], isAlerted: false, spawnRegion: { lon: [-130, -70], lat: [25, 50] } },
    SA: { name: 'SOUTH AMERICA', color: '#00ff00', targets: [], assets: [], isAlerted: false, spawnRegion: { lon: [-80, -40], lat: [-50, 10] } },
    EU: { name: 'EUROPE', color: '#0000ff', targets: [], assets: [], isAlerted: false, spawnRegion: { lon: [-10, 30], lat: [35, 60] } },
    AF: { name: 'AFRICA', color: '#ffff00', targets: [], assets: [], isAlerted: false, spawnRegion: { lon: [-20, 50], lat: [-35, 30] } },
    RU: { name: 'RUSSIA', color: '#ff0000', targets: [], assets: [], isAlerted: false, spawnRegion: { lon: [40, 180], lat: [50, 70] } },
    AS: { name: 'ASIA', color: '#ff9900', targets: [], assets: [], isAlerted: false, spawnRegion: { lon: [60, 150], lat: [10, 45] } },
    ROGUE: { name: 'UNKNOWN', color: '#fff', targets: [], assets: [], isAlerted: true }
};

// Unit Stats & Limits
const UNIT_STATS = {
    CARRIER: { hp: 1000, range: 150, damage: 2, speed: 0.02, limit: 2, targets: ['FIGHTER', 'BOMBER', 'SUB'], hangar: 10 },
    SUB: { hp: 300, range: 200, damage: 50, speed: 0.05, limit: 4, targets: ['CARRIER', 'SUB'], ammo: 5 },
    BOMBER: { hp: 100, range: 20, damage: 200, speed: 0.4, limit: 0, targets: ['CITY', 'SUB', 'SILO'], type: 'AIR' },
    FIGHTER: { hp: 50, range: 50, damage: 10, speed: 0.8, limit: 0, targets: ['BOMBER', 'FIGHTER', 'CARRIER'], type: 'AIR' },
    SILO: { hp: 500, range: 9999, damage: 0, speed: 0, limit: 5, targets: ['CITY', 'SILO'], ammo: 10 } // Static Launchpad
};

// Resize Canvas
function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
}
window.addEventListener('resize', resize);
resize();

// Clock
function updateClock() {
    const now = new Date();
    clockDisplay.innerText = now.toISOString().split('T')[1].split('.')[0] + ' UTC';
}
setInterval(updateClock, 1000);

// Projection
function project(lon, lat) {
    const scale = Math.min(width / 360, height / 180) * 0.9;
    const xOffset = (width - 360 * scale) / 2;
    const yOffset = (height - 180 * scale) / 2;
    const x = (lon + 180) * scale + xOffset;
    const y = (90 - lat) * scale + yOffset;
    return { x, y };
}

function unproject(x, y) {
    const scale = Math.min(width / 360, height / 180) * 0.9;
    const xOffset = (width - 360 * scale) / 2;
    const yOffset = (height - 180 * scale) / 2;
    const lon = (x - xOffset) / scale - 180;
    const lat = 90 - (y - yOffset) / scale;
    return { lon, lat };
}

// Utils
function dist(p1, p2) {
    return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

// Helper: Point in Polygon (Ray Casting)
function isPointInPoly(point, vs) {
    let x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i][0], yi = vs[i][1];
        let xj = vs[j][0], yj = vs[j][1];
        let intersect = ((yi > y) != (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function isOnLand(lon, lat) {
    // Check all map features
    for (const feature of mapData) {
        if (feature.geometry.type === 'Polygon') {
            if (feature.geometry.coordinates.some(ring => isPointInPoly([lon, lat], ring))) return true;
        } else if (feature.geometry.type === 'MultiPolygon') {
            if (feature.geometry.coordinates.some(poly => poly.some(ring => isPointInPoly([lon, lat], ring)))) return true;
        }
    }
    return false;
}

class Unit {
    constructor(type, faction, lon, lat) {
        this.type = type;
        this.faction = faction;
        this.pos = project(lon, lat);
        this.lon = lon;
        this.lat = lat;
        this.dead = false;
        this.target = null;
        this.combatTarget = null;

        const stats = UNIT_STATS[type];
        this.hp = stats.hp;
        this.maxHp = stats.hp;
        this.range = stats.range;
        this.damage = stats.damage;
        this.speed = stats.speed;
        this.validTargets = stats.targets;

        this.ammo = stats.ammo || 0;
        this.hangar = stats.hangar || 0;
        this.isAir = stats.type === 'AIR';
        this.isNaval = (type === 'SUB' || type === 'CARRIER');

        this.cooldown = Math.random() * 100 + 50;
    }

    update() {
        if (this.dead) return;
        this.cooldown--;

        // 1. CARRIER LOGIC
        if (this.type === 'CARRIER' && defcon === 1 && this.hangar > 0 && this.cooldown <= 0) {
            const type = Math.random() > 0.4 ? 'FIGHTER' : 'BOMBER';
            const { lon, lat } = unproject(this.pos.x, this.pos.y);
            units.push(new Unit(type, this.faction, lon, lat));
            this.hangar--;
            this.cooldown = 200;
        }

        // 2. MOVEMENT LOGIC
        if (this.isAir) {
            this.findTarget();
            if (this.combatTarget) {
                this.moveTo(this.combatTarget.pos);
            } else if (this.type === 'BOMBER') {
                this.findCityTarget();
                if (this.target) this.moveTo(this.target);
            } else {
                this.patrol();
            }
        }
        else if (this.type === 'SUB') {
            if (this.ammo <= 0) {
                // Hunter-Killer Mode: Hunt Subs/Carriers
                this.findTarget();
                if (this.combatTarget) {
                    this.moveTo(this.combatTarget.pos);
                } else {
                    this.patrol();
                }
            } else {
                this.patrol();
            }
        }
        else if (this.type === 'SILO') {
            // Static
        }
        else {
            this.patrol();
        }

        // 3. COMBAT LOGIC
        if (defcon === 1 && this.faction.isAlerted) {
            // SILO LAUNCH
            if (this.type === 'SILO' && this.ammo > 0 && this.cooldown <= 0) {
                this.launchMissile();
            }

            // SUB LAUNCH
            if (this.type === 'SUB' && this.ammo > 0 && this.cooldown <= 0) {
                this.launchMissile();
            }

            // SUB/FIGHTER/CARRIER ATTACK (Lasers/Torpedos)
            // Subs now attack when out of ammo OR if they have a target in range (Hunter Mode)
            if ((this.type === 'FIGHTER' || this.type === 'CARRIER' || (this.type === 'SUB' && this.ammo <= 0)) && this.cooldown <= 0) {
                this.findTarget();
                if (this.combatTarget && dist(this.pos, this.combatTarget.pos) <= this.range) {
                    this.fireLaser();
                    this.cooldown = 30;
                }
            }

            // BOMBER ATTACK
            if (this.type === 'BOMBER' && this.cooldown <= 0) {
                if (this.target && dist(this.pos, this.target) < 5) {
                    this.dropBomb(this.target);
                    this.cooldown = 100;
                } else if (this.combatTarget && dist(this.pos, this.combatTarget.pos) < 5) {
                    this.dropBomb(this.combatTarget.pos);
                    this.cooldown = 100;
                }
            }
        }
    }

    moveTo(targetPos) {
        const dx = targetPos.x - this.pos.x;
        const dy = targetPos.y - this.pos.y;
        const d = Math.sqrt(dx * dx + dy * dy);

        if (d > 1) {
            const nextX = this.pos.x + (dx / d) * this.speed;
            const nextY = this.pos.y + (dy / d) * this.speed;

            // Water Restriction for Naval Units
            if (this.isNaval) {
                const { lon, lat } = unproject(nextX, nextY);
                if (isOnLand(lon, lat)) {
                    // Hit land, stop or pick new target
                    this.target = null;
                    return;
                }
            }

            this.pos.x = nextX;
            this.pos.y = nextY;
        }
    }

    patrol() {
        if (!this.target && Math.random() > 0.99) {
            // Pick a random point
            const randX = this.pos.x + (Math.random() - 0.5) * 100;
            const randY = this.pos.y + (Math.random() - 0.5) * 100;

            // If Naval, ensure target is in water
            if (this.isNaval) {
                const { lon, lat } = unproject(randX, randY);
                if (!isOnLand(lon, lat)) {
                    this.target = { x: randX, y: randY };
                }
            } else {
                this.target = { x: randX, y: randY };
            }
        }
        if (this.target) {
            this.moveTo(this.target);
            if (this.target && dist(this.pos, this.target) < 2) this.target = null;
        }
    }

    findTarget() {
        if (this.combatTarget && (this.combatTarget.dead || (this.type !== 'FIGHTER' && dist(this.pos, this.combatTarget.pos) > this.range * 2))) {
            this.combatTarget = null;
        }

        if (!this.combatTarget) {
            const scanRange = this.isAir ? 1000 : this.range;

            const enemies = units.filter(u =>
                u.faction !== this.faction &&
                !u.dead &&
                this.validTargets.includes(u.type) &&
                dist(this.pos, u.pos) <= scanRange
            );

            if (enemies.length > 0) {
                enemies.sort((a, b) => dist(this.pos, a.pos) - dist(this.pos, b.pos));
                this.combatTarget = enemies[0];
            }
        }
    }

    findCityTarget() {
        if (this.target) return;
        // Pick a random enemy faction
        const enemyFactions = Object.values(FACTIONS).filter(f => f !== this.faction && f !== FACTIONS.ROGUE && f.targets.length > 0);
        if (enemyFactions.length > 0) {
            const ef = enemyFactions[Math.floor(Math.random() * enemyFactions.length)];
            // Prioritize Silos
            const silos = units.filter(u => u.faction === ef && u.type === 'SILO' && !u.dead);
            if (silos.length > 0) {
                this.target = silos[Math.floor(Math.random() * silos.length)].pos;
            } else {
                const t = ef.targets[Math.floor(Math.random() * ef.targets.length)];
                this.target = project(t[0], t[1]);
            }
        }
    }

    fireLaser() {
        if (!this.combatTarget) return;
        ctx.beginPath();
        ctx.moveTo(this.pos.x, this.pos.y);
        ctx.lineTo(this.combatTarget.pos.x, this.combatTarget.pos.y);
        ctx.strokeStyle = this.faction.color;
        ctx.lineWidth = 1;
        ctx.stroke();
        this.combatTarget.takeDamage(this.damage);
    }

    dropBomb(targetPos) {
        explosions.push(new Explosion(targetPos.x, targetPos.y, this.faction));
        units.forEach(u => {
            if (u.faction !== this.faction && dist(u.pos, targetPos) < 10) {
                u.takeDamage(this.damage);
            }
        });
        checkImpact(targetPos.x, targetPos.y, this.faction);
    }

    launchMissile() {
        // Target random enemy city or Silo
        const enemyFactions = Object.values(FACTIONS).filter(f => f !== this.faction && f !== FACTIONS.ROGUE && f.targets.length > 0);
        if (enemyFactions.length === 0) return;

        const ef = enemyFactions[Math.floor(Math.random() * enemyFactions.length)];
        let targetPos;

        // Priority: Silos -> Carriers -> Cities
        const targets = units.filter(u => u.faction === ef && (u.type === 'SILO' || u.type === 'CARRIER') && !u.dead);
        if (targets.length > 0) {
            const t = targets[Math.floor(Math.random() * targets.length)];
            const { lon, lat } = unproject(t.pos.x, t.pos.y);
            targetPos = [lon, lat];
        } else {
            targetPos = ef.targets[Math.floor(Math.random() * ef.targets.length)];
        }

        if (targetPos) {
            const { lon, lat } = unproject(this.pos.x, this.pos.y);
            missiles.push(new Missile(lon, lat, targetPos[0], targetPos[1], this.faction));
            this.ammo--;
            this.cooldown = 400; // Silo reload is slow
        }
    }

    takeDamage(amount) {
        this.hp -= amount;
        if (this.hp <= 0) {
            this.dead = true;
            explosions.push(new Explosion(this.pos.x, this.pos.y, this.faction));
        }
    }

    draw() {
        ctx.fillStyle = this.faction.color;
        ctx.font = '12px monospace';
        let icon = '?';
        if (this.type === 'BOMBER') icon = '✈';
        if (this.type === 'SUB') icon = '(S)';
        if (this.type === 'CARRIER') icon = '⛴';
        if (this.type === 'FIGHTER') icon = '>';
        if (this.type === 'SILO') icon = '▲';

        ctx.fillText(icon, this.pos.x - 5, this.pos.y + 5);

        const hpPct = this.hp / this.maxHp;
        ctx.fillStyle = `hsl(${hpPct * 120}, 100%, 50%)`;
        ctx.fillRect(this.pos.x - 5, this.pos.y - 8, 10 * hpPct, 2);
    }
}

class Missile {
    constructor(startLon, startLat, endLon, endLat, faction) {
        this.start = project(startLon, startLat);
        this.end = project(endLon, endLat);
        this.faction = faction;
        this.progress = 0;
        this.speed = Math.random() * 0.005 + 0.002;
        this.maxHeight = dist(this.start, this.end) * 0.5;
        this.dead = false;
    }

    update() {
        this.progress += this.speed;
        if (this.progress >= 1) {
            this.progress = 1;
            this.dead = true;
            explosions.push(new Explosion(this.end.x, this.end.y, this.faction));
            checkImpact(this.end.x, this.end.y, this.faction);
        }
    }

    draw() {
        const midX = (this.start.x + this.end.x) / 2;
        const midY = (this.start.y + this.end.y) / 2 - this.maxHeight;

        const x = (1 - this.progress) * (1 - this.progress) * this.start.x +
            2 * (1 - this.progress) * this.progress * midX +
            this.progress * this.progress * this.end.x;

        const y = (1 - this.progress) * (1 - this.progress) * this.start.y +
            2 * (1 - this.progress) * this.progress * midY +
            this.progress * this.progress * this.end.y;

        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = this.faction.color;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(this.start.x, this.start.y);
        ctx.lineTo(x, y);
        ctx.strokeStyle = `rgba(255,255,255,0.1)`;
        ctx.stroke();
    }
}

class Explosion {
    constructor(x, y, faction) {
        this.x = x;
        this.y = y;
        this.radius = 1;
        this.maxRadius = Math.random() * 20 + 10;
        this.alpha = 1;
        this.dead = false;
        this.faction = faction;
    }

    update() {
        this.radius += 0.5;
        this.alpha -= 0.02;
        if (this.alpha <= 0) this.dead = true;
    }

    draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${this.alpha})`;
        ctx.fill();
        ctx.strokeStyle = this.faction.color;
        ctx.stroke();
    }
}

// Game Logic
function setDefcon(level) {
    defcon = level;
    const info = DEFCON_LEVELS[level];
    const footer = document.querySelector('footer p');
    if (footer) {
        footer.innerText = `DEFCON ${level} // ${info.text}`;
        footer.style.color = info.color;
    }

    if (level === 1 && !gameStarted) {
        gameStarted = true;
        clearInterval(defconInterval);
        startBombardment();

        // Show "COCKED PISTOL" for interval time (1s), then switch to "CALCULATIONS..."
        setTimeout(() => {
            if (!victorySecured) {
                const footer = document.querySelector('footer p');
                if (footer) {
                    footer.innerText = "CALCULATIONS...";
                    footer.style.color = "#ff0000";
                }
            }
        }, 1000);
    }
}

function startDefconCycle() {
    let defconLevel = 5;
    setDefcon(defconLevel);

    const defconInterval = setInterval(() => {
        if (defconLevel > 1) {
            defconLevel -= 1; // Decrement level by 1
        } else {
            clearInterval(defconInterval); // Stop the interval when it reaches 1
        }
        setDefcon(defconLevel);
    }, 1000);
}

function checkImpact(x, y, aggressor) {
    const { lon, lat } = unproject(x, y);

    // Check unit hits (Silos/Carriers)
    units.forEach(u => {
        if (u.faction !== aggressor && !u.dead && dist(u.pos, { x, y }) < 10) {
            u.takeDamage(1000); // Direct hit kills
        }
    });

    // Identify victim faction
    let victim = null;
    for (const key in FACTIONS) {
        const f = FACTIONS[key];
        if (f === FACTIONS.ROGUE) continue;
        if (f.targets.some(t => Math.abs(t[0] - lon) < 5 && Math.abs(t[1] - lat) < 5)) {
            victim = f;
            break;
        }
    }

    if (!victim) {
        if (lat > 15 && lon < -30) victim = FACTIONS.NA;
        else if (lat <= 15 && lon < -30) victim = FACTIONS.SA;
        else if (lat > 30 && lon > -30 && lon < 40) victim = FACTIONS.EU;
        else if (lat <= 30 && lon > -30 && lon < 60) victim = FACTIONS.AF;
        else if (lat > 45 && lon > 40) victim = FACTIONS.RU;
        else if (lon > 60) victim = FACTIONS.AS;
    }

    if (victim && !victim.isAlerted && victim !== aggressor) {
        victim.isAlerted = true;
        spawnFactionUnits(victim);
    }
}

function spawnFactionUnits(faction) {
    const region = faction.spawnRegion;
    const spawn = (type, count) => {
        const isNaval = (type === 'CARRIER' || type === 'SUB');
        const isLand = (type === 'SILO');

        for (let i = 0; i < count; i++) {
            let lon, lat, valid = false;
            let attempts = 0;
            // Try to find a valid spot
            while (!valid && attempts < 50) {
                lon = region.lon[0] + Math.random() * (region.lon[1] - region.lon[0]);
                lat = region.lat[0] + Math.random() * (region.lat[1] - region.lat[0]);

                const onLand = isOnLand(lon, lat);

                if (isNaval) {
                    if (!onLand) valid = true; // Must be in water
                } else if (isLand) {
                    if (onLand) valid = true; // Must be on land
                } else {
                    valid = true; // Air units or others can be anywhere (though they spawn from carriers usually)
                }
                attempts++;
            }

            if (valid) {
                units.push(new Unit(type, faction, lon, lat));
            }
        }
    };

    spawn('CARRIER', UNIT_STATS.CARRIER.limit);
    spawn('SUB', UNIT_STATS.SUB.limit);
    spawn('SILO', UNIT_STATS.SILO.limit);
}

function startBombardment() {
    for (let i = 0; i < 5; i++) {
        setTimeout(() => {
            const target = targets[Math.floor(Math.random() * targets.length)];
            if (target) {
                missiles.push(new Missile(userLon, userLat, target[0], target[1], FACTIONS.ROGUE));
            }
        }, i * 500);
    }
}

// Initialization
async function initMap() {
    try {
        const response = await fetch('https://unpkg.com/world-atlas@2.0.2/countries-110m.json');
        const topology = await response.json();
        const geojson = topojson.feature(topology, topology.objects.countries);
        mapData = geojson.features;

        mapData.forEach(feature => {
            const extractCoords = (coords) => {
                coords.forEach(coord => {
                    const lon = coord[0];
                    const lat = coord[1];

                    if (lat > 15 && lon < -30) FACTIONS.NA.targets.push(coord);
                    else if (lat <= 15 && lon < -30) FACTIONS.SA.targets.push(coord);
                    else if (lat > 30 && lon > -30 && lon < 40) FACTIONS.EU.targets.push(coord);
                    else if (lat <= 30 && lon > -30 && lon < 60) FACTIONS.AF.targets.push(coord);
                    else if (lat > 45 && lon > 40) FACTIONS.RU.targets.push(coord);
                    else if (lon > 60) FACTIONS.AS.targets.push(coord);

                    targets.push(coord);
                });
            };

            if (feature.geometry.type === 'Polygon') {
                feature.geometry.coordinates.forEach(extractCoords);
            } else if (feature.geometry.type === 'MultiPolygon') {
                feature.geometry.coordinates.forEach(polygon => polygon.forEach(extractCoords));
            }
        });

        getUserLocation();
        animate();
    } catch (error) {
        console.error("Map Error", error);
    }
}

async function getUserLocation() {
    try {
        const res = await fetch('https://ip.guide/');
        const data = await res.json();

        if (data === null) throw new Error("API Limit or Error");

        userLat = data.location.latitude;
        userLon = data.location.longitude;
        locationDisplay.innerText = `DETECTED_ORIGIN: ${data.location.city.toUpperCase()}, ${data.location.country}`;

        startDefconCycle();

    } catch (e) {
        console.warn("IP fetch failed", e);
        if (targets.length > 0) {
            const randomTarget = targets[Math.floor(Math.random() * targets.length)];
            userLon = randomTarget[0];
            userLat = randomTarget[1];
            locationDisplay.innerText = "ORIGIN: CLASSIFIED // PROXY_DETECTED";
        } else {
            userLat = 40.7128;
            userLon = -74.0060;
            locationDisplay.innerText = "ORIGIN: UNKNOWN // DEFAULTING";
        }
        startDefconCycle();
    }
}

function animate() {
    ctx.fillStyle = 'rgba(5, 5, 5, 0.3)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#004444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    mapData.forEach(feature => {
        const drawRing = (ring) => {
            ring.forEach((coord, i) => {
                const p = project(coord[0], coord[1]);
                if (i === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
        };
        if (feature.geometry.type === 'Polygon') feature.geometry.coordinates.forEach(drawRing);
        else if (feature.geometry.type === 'MultiPolygon') feature.geometry.coordinates.forEach(p => p.forEach(drawRing));
    });
    ctx.stroke();

    units.forEach(u => {
        u.update();
        u.draw();
    });
    units = units.filter(u => !u.dead);

    missiles.forEach(m => {
        m.update();
        m.draw();
    });
    missiles = missiles.filter(m => !m.dead);

    explosions.forEach(e => {
        e.update();
        e.draw();
    });
    explosions = explosions.filter(e => !e.dead);

    requestAnimationFrame(animate);
    checkVictory();
}

function checkVictory() {
    if (defcon !== 1) return;

    // Count active factions (excluding Rogue)
    const activeFactions = new Set();
    units.forEach(u => {
        if (u.faction !== FACTIONS.ROGUE && !u.dead) {
            activeFactions.add(u.faction);
        }
    });

    // Count how many factions have ever been involved (Alerted)
    let alertedCount = 0;
    for (const key in FACTIONS) {
        if (FACTIONS[key] !== FACTIONS.ROGUE && FACTIONS[key].isAlerted) {
            alertedCount++;
        }
    }

    // Victory condition:
    // 1. Only one faction has active units.
    // 2. At least 2 factions were involved in the war (prevents early victory when only 1 spawns).
    if (activeFactions.size === 1 && alertedCount >= 2) {
        victorySecured = true;
        const winner = activeFactions.values().next().value;
        const footer = document.querySelector('footer p');
        if (footer) {
            footer.innerText = `UNCONTESTED DOMINANCE SECURED`;
            footer.style.color = winner.color;
        }
    }
}

initMap();
