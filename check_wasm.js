const path = require('path');

try {
    const wasmModulePath = path.resolve(__dirname, './mev_engine/pkg');
    console.log('Attempting to load WASM module from:', wasmModulePath);

    const wasmModule = require(wasmModulePath);
    console.log('WASM module loaded successfully!');
    console.log('Exports:', Object.keys(wasmModule));

    if (typeof wasmModule.detectMevSandwich === 'function') {
        console.log('detectMevSandwich is a function!');
    } else {
        console.error('detectMevSandwich is NOT a function. Type:', typeof wasmModule.detectMevSandwich);
    }

} catch (e) {
    console.error('Error loading WASM module:', e);
}