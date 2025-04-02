import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join, extname, resolve } from 'path';
import { promises as fs } from 'fs';
import cors from 'cors';

import { parseSDF } from './src/sdfProcess.js';
import { parseVerilog } from './src/vProcess.js';
import { mergeJsonForD3 } from './src/mergeVerilogSdf.js';

export const app = express();
const PORT = 3000;

// Get absolute path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Authorize CORS
app.use(cors());
app.use(express.json());

// Configure multer for handling SDF file upload
// Store file in memory, not on disk
const storage = multer.memoryStorage(); 

// Filter to verify file type
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const fieldExtensionMap = {
            sdfFile: ['.sdf'],
            verilogFile: ['.v']
        };

        // Check if the file field name is in the map
        const fileExtension = extname(file.originalname).toLowerCase();
        const allowedExtensions = fieldExtensionMap[file.fieldname];

        if (allowedExtensions && allowedExtensions.includes(fileExtension)) {
            cb(null, true);
        } else {
            req.fileValidationError = `Invalid file(s) format.`;
            cb(null, false);
        }
    },
});


// Endpoint for uploading and parsing SDF & Verilog file
app.post('/api/upload', upload.fields([{ name: 'sdfFile' }, { name: 'verilogFile' }]), async (req, res) => {
    try {
        // verify if files are uploaded
        if (req.fileValidationError) {
            return res.status(400).send(req.fileValidationError);
        }   

        const sdfFile = req.files?.['sdfFile']?.[0];
        const verilogFile = req.files?.['verilogFile']?.[0];

        // Check if files are uploaded
        if (!sdfFile || !verilogFile) {
            return res.status(400).send('Both SDF and Verilog files must be uploaded.');
        }

        const sdfContent = sdfFile.buffer.toString('utf-8').trim();
        const verilogContent = verilogFile.buffer.toString('utf-8').trim();

        if (!sdfContent || !verilogContent) {
            return res.status(400).send('One or both uploaded files are empty.');
        }

        // Parse SDF and Verilog files
        let sdfData, verilogData, commonInstances;
        try {
            sdfData = parseSDF(sdfContent);
        } catch (error) {
            return res.status(500).send('Error parsing SDF file.');
        }

        try {
            verilogData = parseVerilog(verilogContent);
        } catch (error) {
            return res.status(500).send('Error parsing Verilog file.');
        }
        
        try {
            commonInstances = mergeJsonForD3(verilogData, sdfData);
        } catch (error) {
            return res.status(500).send('Error merging files.');
        }

        // Save parsed SDF and Verilog files
        try {
            const projectName = req.body.projectName;
            if (!projectName) {
                return res.status(400).send('Project name is required.');
            }

            //try if folder 'parsed_files' exists
            try {
                await fs.access(join(__dirname, 'parsed_files'));
            } catch (error) {
                try {
                    await fs.mkdir(join(__dirname, 'parsed_files'));
                } catch (error) {
                    return res.status(500).send('Error creating directory.');
                }
            }

            const projectJSON_Path = join(__dirname, 'parsed_files', `${projectName}.json`);

            //check if files exists
            try {
                // check if file exists
                await fs.access(projectJSON_Path);
                return res.status(400).send('The project already exists.');

            } catch (error) {
                try {
                    await fs.writeFile(join(projectJSON_Path), JSON.stringify(commonInstances, null, 2));
                    res.status(200).send('Files uploaded successfully.');

                } catch (error) {
                    res.status(500).send('Error saving parsed JSON files.');
                }
            }

        } catch (error) {
            res.status(500).send('Error saving parsed JSON files.');
        }

    } catch (error) {
        res.status(500).send('Unexpected server error.');
    }
});

// Endpoint to show a error message if no project name is provided
app.get('/api/map', (req, res) => {
    return res.status(400).send('Project name is required.');
});
  
// Endpoint API for sending parsed SDF file
app.get('/api/map/:projectName', async (req, res) => {
    try {
        const projectName = req.params.projectName;
        if (!projectName) {
            return res.status(400).send('Project name is required.');
        }

        // Construct the file path using string concatenation
        const jsonFilePath = join(__dirname, 'parsed_files', `${projectName}.json`);
        
        // Check if the file exists
        await fs.access(jsonFilePath);

        // Read the file content
        const jsonData = await fs.readFile(jsonFilePath, 'utf-8');
        res.json(JSON.parse(jsonData));

    } catch (error) {
        if (error.code === 'ENOENT') {
            // File does not exist
            return res.status(400).send('Project not found.');
        }
        res.status(500).send('Error reading parsed SDF JSON file.');
    }
});

// Endpoint to delete a parsed SDF JSON file
app.delete('/api/delete-project/:projectName', async (req, res) => {
    try {
        const projectName = req.params.projectName;

        // Validate projectName
        if (!projectName || typeof projectName !== 'string') {
            return res.status(400).send('Invalid project name.');
        }

        const projectPath = join(__dirname, 'parsed_files', `${projectName}.json`);

        try {
            // verify if file exists
            await fs.access(projectPath);
        } catch (err) {
            // file does not exist
            return res.status(404).send('Project does not exist.');    
        }

        // Delete file
        await fs.unlink(projectPath);
        res.send('File deleted successfully.');

    } catch (error) {
        res.status(500).send('Error deleting file, please try again later.');
    }
});


// Endpoint to list all SDF files
app.get('/api/list', async (req, res) => {
    try {
        const directoryPath = join(__dirname, 'parsed_files');

        // Check if the directory exists
        try {
            await fs.access(directoryPath);
        } catch (error) {
            // Create the directory if it doesn't exist
            await fs.mkdir(directoryPath, { recursive: true });
        }

        const entries = await fs.readdir(directoryPath, { withFileTypes: true });

        // Prepare an array to hold file information
        const filesInfo = [];

        // Iterate over entries to get file names and creation dates
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.json')) {
                const filePath = join(directoryPath, entry.name);
                const stats = await fs.stat(filePath);

                // Format the date to only include the date part (YYYY-MM-DD)
                const createdDate = stats.birthtime.toISOString().split('T')[0];

                filesInfo.push({
                    name: entry.name.replace('.json', ''),
                    createdDate
                });
            }
        }

        res.json(filesInfo);
    } catch (error) {
        res.status(500).send('Error listing files.');
    }
});

// Serve static files from the frontend directory
app.use(express.static(join(__dirname, '../frontend/')));

// Serve the frontend application for all other routes
app.get('*', (req, res) => {
    res.sendFile(resolve(__dirname, '../frontend/', 'index.html'));
});

export const server = app.listen(PORT, () => {});
