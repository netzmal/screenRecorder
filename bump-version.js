const fs = require('fs');
const path = require('path');

function updateVersion(filePath) {
    if (!fs.existsSync(filePath)) return;

    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let version = pkg.version || '1.0.0';
    
    // Format: major.minor.build
    const parts = version.split('.');
    
    let major = parts[0] || '1';
    let minor = parts[1] || '0';
    let build = parseInt(parts[2] || '0', 10);
    
    build++;
    
    const newVersion = `${major}.${minor}.${build}`;
    pkg.version = newVersion;
    
    fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated version to ${newVersion} in: ${filePath}`);
    return newVersion;
}

const rootPkgPath = path.join(__dirname, 'package.json');
const installPkgPath = path.join(__dirname, 'install', 'package.json');

const newVersion = updateVersion(rootPkgPath);
if (newVersion) {
    updateVersion(installPkgPath);
}
