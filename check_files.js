const fs = require('fs');
const path = require('path');

const directoryPath = 'C:\\Users\\umami\\Documents\\mev-detector'; // Your project root

fs.readdir(directoryPath, (err, files) => {
  if (err) {
    console.error('Error reading directory:', err);
    return;
  }
  console.log('Files in directory:', files);
});