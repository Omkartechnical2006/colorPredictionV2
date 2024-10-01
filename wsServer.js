const WebSocket = require('ws');
const Cycle = require('./models/cycle');
const WingoBetResult = require('./models/WingoBetResult');
function startWebSocketServer(port) {
    const wss = new WebSocket.Server({ port });
    wss.on('connection', (ws) => {
        console.log('Client connected');
        // Send the initial state to the newly connected client
        ws.send(JSON.stringify({ timeLeft: 60, cycleCount: 1, cycleId: '0000000000' }));
        // Optionally send initial data to the client
        sendInitialResults(ws);
        ws.on('close', () => {
            console.log('Client disconnected');
        });
    });
    return wss;
}

async function saveCycleToDB(cycleId) {
    try {
        // Delete any existing cycle document
        await Cycle.deleteMany({});
        // Now save the new cycle ID
        const newCycle = new Cycle({ cycleId });
        await newCycle.save();
        // console.log(`Cycle saved: ${cycleId}`);
    } catch (err) {
        console.error("Error saving cycle to DB:", err);
    }
}
//remove funciton
// Function to send all created results to the newly connected client
function sendInitialResults(ws) {
    WingoBetResult.find({})
        .sort({ currCycleId: -1 }) // Sort by currCycleId in descending order
        .limit(10) // Limit the results to 10
        .then(recentResults => {
            ws.send(JSON.stringify(recentResults)); // Send only recent 10 results to the client
        })
        .catch(err => {
            console.error("Error fetching results:", err);
        });
}


module.exports = { startWebSocketServer, saveCycleToDB };
