const fs = require('fs');
const path = require('path');

const destDir = process.argv[2];

if (!destDir) {
    console.error('Target directory not specified. Usage: node tools/deploy.js <target-path>');
    process.exit(1);
}

const excludes = [
    '.htaccess',
    '.htpasswd',
    'monaco',
    path.join('assets', 'system_files', 'scenario', 'fareast')
];

console.log(`Starting post-deployment cleanup and patching in ${destDir}...`);

if (!fs.existsSync(destDir)) {
    console.error(`Destination directory ${destDir} does not exist.`);
    process.exit(1);
}

// 1. Cleanup excluded files/folders
console.log('Cleaning up excluded files and folders...');
excludes.forEach(exclude => {
    const targetPath = path.join(destDir, exclude);
    if (fs.existsSync(targetPath)) {
        console.log(`Removing: ${targetPath}`);
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
    }
});

// 2. Patch scenarios.json
const scenariosPath = path.join(destDir, 'assets', 'system_files', 'scenario', 'scenarios.json');
if (fs.existsSync(scenariosPath)) {
    console.log('Patching scenarios.json...');
    try {
        const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
        const filteredScenarios = scenarios.filter(s => s.id !== 'fareast');
        fs.writeFileSync(scenariosPath, JSON.stringify(filteredScenarios, null, 4), 'utf8');
        console.log('scenarios.json patched successfully.');
    } catch (err) {
        console.error('Error patching scenarios.json:', err);
    }
} else {
    console.warn('scenarios.json not found in destination for patching.');
}

console.log('Post-deployment processing finished.');
