require('dotenv').config();
const express = require("express");
const app = express();
const path = require('path');
const session = require("express-session");
const MongoStore = require("connect-mongo");
const methodOverride = require('method-override');
const Cycle = require('./models/cycle');
const Info = require('./models/Info');
const WingoBetResult = require('./models/WingoBetResult');
const passport = require("passport");
const flash = require('connect-flash');
const LocalStrategy = require("passport-local");
const User = require("./models/user.js");
const resetResultDb = require('./utils/resetResultDb');
const { isLoggedIn } = require("./middlewares/isLoggedIn.js");
const mongoose = require('mongoose');
const signupRouter = require("./routes/signup.js");
const adminRouter = require("./routes/admin.js");
const wingoRouter = require("./routes/wingo.js");
const isAdmin = require('./middlewares/isAdmin.js');
const Wingo3Bet = require('./models/wingo3bet');
const loginRouter = require("./routes/login.js");
const mainRouter = require("./routes/main.js");
const dbUrl = process.env.MONGO_URL;
const initializeDefaultData = require('./utils/initializeData');
const fetchCurrentCycleData = require('./utils/fetchCurrentCycleData');
const { resultRule } = require('./utils/resultFetcher');
const WebSocket = require('ws');
const { startWebSocketServer, saveCycleToDB } = require('./wsServer');
const { startTimer, timeLeft, cycleCount, currentCycleId } = require('./timer');
const { calculateResultTime } = require('./utils/calculateResultTime');
const port = process.env.PORT || 3000;
const store = MongoStore.create({
    mongoUrl: dbUrl,
    crypto: {
        secret: process.env.SECRET
    },
    touchAfter: 24 * 3600,
});
store.on("error", (err) => {
    console.log("Error in mongo session store", err);
})
const sessionOptions = {
    store,
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
    },
}
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(flash());
app.use(express.static('public'));
app.use(express.json()); // to parse JSON data
app.use(express.urlencoded({ extended: true })); // to parse URL-encoded form data
app.use(methodOverride('_method'));

app.use(session(sessionOptions));
app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());


// Middleware to make flash messages available in all views
app.use((req, res, next) => {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    next();
});
// req will be available on ejs 
app.use((req, res, next) => {
    res.locals.user = req.user;
    next();
});
// MongoDB connection
mongoose.connect(dbUrl)
    .then(async () => {
        console.log('Connected to MongoDB');
        resetResultDb();
        initializeCycle();
        await initializeDefaultData();
    })
    .catch(err => console.error("MongoDB connection error:", err));

// wingo One Minute Result Edit 
app.get("/admin/wingooneresult", isLoggedIn, isAdmin, (req, res) => {
    let resultStatus = "";
    res.render("admin/wingoOneResult.ejs", { resultStatus });
})
app.post("/admin/wingooneresult", isLoggedIn, isAdmin, async (req, res) => {
    const { color, size, selectedNumber } = req.body;
    // Check for missing fields
    if (!color || !size || !selectedNumber) {
        req.flash("error", "Missing fields");
        console.log("missing fields");
        return res.redirect("/admin/wingooneresult");
    }
    try {
        // Fetch the current cycle data
        const cycleData = await fetchCurrentCycleData();
        if (!cycleData) {
            req.flash("error", "No active cycle found");
            return res.redirect("/admin/wingooneresult");
        }
        const { cycleId, createdAt } = cycleData;
        const currentTime = new Date();
        const elapsedTime = currentTime - createdAt; // Time in milliseconds
        // If the request is made after 58 seconds
        if (elapsedTime > 59 * 1000) {
            // Check if the result for this cycle already exists in the database
            const existingResult = await WingoBetResult.findOne({ currCycleId: cycleId });
            if (existingResult) {
                console.log("you are late result has been declared");
                req.flash("error", "Result for this cycle has already been declared");
                return res.redirect("/admin/wingooneresult"); // Redirect to home if result already exists
            } else {
                console.log('able to apply your result')
                // 59 seconds have passed, and no result exists yet, allow declaring the result
                req.flash("success", `You can now declare the result for cycle ${cycleId}`);
                return res.redirect("/admin/wingooneresult"); // Redirect to result declaration page
            }
        } else {
            // If the request is made before 55 seconds, process and fetch relevant bets
            const upperLimit = new Date(createdAt.getTime() + 55 * 1000); // Limit bet time to 55 seconds
            // Fetch bets within the first 55 seconds of the current cycle
            const WingoThreeBet = await Wingo3Bet.find({
                date: {
                    $gt: createdAt,
                    $lte: upperLimit
                }
            });

            // Create the result for the current cycle
            const result = await WingoBetResult.create({
                bigSmallResult: size, // Assuming 'size' corresponds to 'bigSmallResult'
                numberResult: selectedNumber, // Assuming 'selectedNumber' corresponds to 'numberResult'
                colorResult: color, // Assuming 'color' corresponds to 'colorResult'
                currCycleId: cycleId
            });

            // Calculate the remaining time to wait for 60 seconds
            const remainingTime = 60 * 1000 - elapsedTime;

            // Log when the `addMoney` function will be triggered

            // Run the `addMoney` function after 60 seconds if the request was made before 60 seconds
            setTimeout(async () => {
                await addMoney(WingoThreeBet);
                console.log("Bets processed and money added.");
            }, remainingTime);
            console.log("sucessfuly process your bets", result);
            req.flash("success", "Your bets have been registered. Results will be processed shortly.");
            return res.redirect("/admin/wingooneresult");
        }
    } catch (error) {
        console.error("Error processing the result:", error);
        req.flash("error", "An error occurred while processing the request.");
        return res.redirect("/admin/wingooneresult");
    }
});


// routes 
app.use("/signup", signupRouter);
app.use("/login", loginRouter);
app.use("/admin", adminRouter);

// Start WebSocket server
const wss = startWebSocketServer(8081);

// Start the server-side timer
startTimer(wss, saveCycleToDB);
app.get("/", (req, res) => {
    res.redirect("/home");
});
app.get("/home", (req, res) => {
    res.render("home/index.ejs");
});

app.use("/wingo", wingoRouter);//wingo game and bet request
async function initializeCycle() {
    try {
        // Check if any cycles exist in the database
        const existingCycle = await Cycle.findOne();
        if (existingCycle) {
            await Cycle.deleteMany({});
        }
        // Create the first cycle with the format YYYYMMDD01
        const now = new Date();
        const year = now.getFullYear().toString();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const initialCycleId = `${year}${month}${day}01`;
        // Create and save the initial cycle
        const newCycle = new Cycle({
            cycleId: initialCycleId,
            createdAt: now
        });
        await newCycle.save();
        // Start the cycle result handling process after initializing the cycle
        // it will only fire handlecylceresult when admin hasn't sent any result 
        handleCycleResult();
    } catch (error) {
        console.error('Error during cycle initialization:', error);
    }
}


// Function to declare the game result
async function declareGameResult(cycleId) {
    let WingoThreebet;
    try {
        // Fetch result from resultRule
        const result = await WingoBetResult.findOne({ currCycleId: cycleId });
        if (!result) {
            console.log(cycleId, "result doesn't exist")
            const rule = await resultRule(); // Assuming resultRule returns { numberResults, colorResults, sizeResults }
            // Extract the arrays from the rule object
            const { numberResults, colorResults, sizeResults, WingoThreeBet } = rule;
            WingoThreebet = WingoThreeBet;
            // Utility function to select a result
            function selectResult(resultsArray) {
                // Find all results with 0 bet amount
                const zeroAmountResults = resultsArray.filter(res => res.totalAmount === 0);
                if (zeroAmountResults.length > 0) {
                    // Randomly select one from the zeroAmountResults
                    return zeroAmountResults[Math.floor(Math.random() * zeroAmountResults.length)].choosedBet;
                } else {
                    // Otherwise, find the result with the least bet amount
                    return resultsArray.reduce((min, current) => {
                        return (min.totalAmount < current.totalAmount) ? min : current;
                    }).choosedBet;
                }
            }
            // Select the result for each category using the utility function
            numberResult = selectResult(numberResults);
            colorResult = selectResult(colorResults);
            bigSmallResult = selectResult(sizeResults);
            // Save the result to the database
            const result = await WingoBetResult.create({
                bigSmallResult,
                numberResult,
                colorResult,
                currCycleId: cycleId
            });
            await addMoney(WingoThreeBet);
        }
        // Notify clients of the result
        console.log("let's notify the clients")
        notifyClients(); // Your WebSocket or client notification logic
    } catch (error) {
        // Function to generate a random number between 0 and 9
        function getRandomNumber0To9() {
            return Math.floor(Math.random() * 10); // Generates 0 to 9
        }
        let bigSmallResult = '';
        let numberResult = getRandomNumber0To9();
        let colorResult='';   // Default
        // Example usage
        // 100 to trade = 2 service fee 
        // green = 1,3,7,9 ;    red= 2,4,6,8   violet = 0,5    0 = mixed (red&violet) 5= mixed(Green & violet)
        // big = 5,6,7,8,9;
        // small = 0,1,2,3,4;
        // total issues = 1440; 
        switch (numberResult) {
            case 0:
                colorResult = 'violet';//mixed red & violet
                bigSmallResult = 'small';
                break;
            case 1:
                bigSmallResult = 'small';
                colorResult = 'green';
                break;
            case 2:
                bigSmallResult = 'small';
                colorResult = 'red';
                break;
                // captcha 1abBcR7 use captcha to save spam and auto submission
            case 3:
                bigSmallResult = 'small';
                colorResult = 'green';
                break;
            case 4:
                bigSmallResult = 'small';
                colorResult = 'red';
                break;
            case 5:
                bigSmallResult = 'big';
                colorResult = 'violet';
                break;
            case 6:
                bigSmallResult = 'big';
                colorResult = 'red';
                break;
            case 7:
                bigSmallResult = 'big';
                colorResult = 'green';
                break;
            case 8:
                bigSmallResult = 'big';
                colorResult = 'red';
                break;
            case 9:
                bigSmallResult = 'big';
                colorResult = 'green';
                break;
            default:
                colorResult = 'yellow'; // Fallback, if needed
        }

        const result = await WingoBetResult.create({
            bigSmallResult,
            numberResult,
            colorResult,
            currCycleId: cycleId
        });
        // if (WingoThreebet) {
        //     await addMoney(WingoThreebet);
        // }
        notifyClients();
    }
}
async function addMoney(WingoThreeBet) {  //let's write amount adding processor now 
    const latestResult = await WingoBetResult.findOne().sort({ date: -1 });
    if (latestResult) {
        bets = WingoThreeBet;
        if (bets) {
            console.log("bets is " + bets);
            calculateWinnings(bets, latestResult);
        }
    }
}

// winning calculation function 
// Function to calculate winnings based on the latest result
async function calculateWinnings(bets, latestResult) {
    try {
        // console.log(bets)

        for (const bet of bets) {
            const userId = bet.userId;
            const betAmount = bet.betAmount;
            let winnings = 0;

            // Check for big/small result
            if (bet.choosedBet === latestResult.bigSmallResult) {
                winnings += betAmount * 2; // 2x if big/small matches
            }

            // Check for color result
            if (bet.choosedBet === latestResult.colorResult) {
                winnings += betAmount * 2; // 2x if color matches
            }

            // Check for number result
            if (bet.choosedBet === latestResult.numberResult.toString()) {
                winnings += betAmount * 9; // 9x if number matches
            }
            // Step 4: Update user balance and bet status
            if (winnings > 0) {
                await User.findByIdAndUpdate(userId, { $inc: { balance: winnings } });
                await Wingo3Bet.findByIdAndUpdate(bet._id, { status: 'won' });
            } else {
                await Wingo3Bet.findByIdAndUpdate(bet._id, { status: 'lost' });
            }

            console.log(`User ${userId} updated: ${winnings > 0 ? 'Won' : 'Lost'}, Balance: ${winnings}`);
        }
    } catch (error) {
        console.error('Error calculating winnings:', error);
    }
}


function notifyClients() {
    WingoBetResult.find({})
        .sort({ currCycleId: -1 }) // Sort by currCycleId in descending order
        .limit(10) // Limit the results to 10
        .then(recentResults => {
            // Send to all clients
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(recentResults)); // Send recent results
                }
            });
        })
        .catch(err => {
            console.error("Error fetching recent results for clients:", err);
        });
}

app.get("/result", (req, res) => {
    res.render("temp.ejs");
})



// Main function to handle automatic result generation and cycle checking
function handleCycleResult() {
    fetchCurrentCycleData()
        .then(cycle => {
            if (!cycle) {
                console.error('No cycle data found');
                return;
            }
            const { cycleId, createdAt } = cycle;
            const resultTime = calculateResultTime(createdAt);
            const delay = resultTime - new Date(); // Time until result should be declared
            console.log(`Result will be declared for cycle ${cycleId} at ${resultTime}`);
            // Wait until the result declaration time
            setTimeout(() => {
                // Declare the result for the current cycle
                declareGameResult(cycleId);
                // Wait 5 seconds after declaring result to confirm next cycle has started
                setTimeout(() => {
                    // console.log(`Checking for the next cycle after 5 seconds...`);
                    // Check for the next cycle after 5 seconds
                    handleCycleResult(); // Recursive call to handle the next cycle
                }, 5000); // Wait 5 seconds to confirm next cycle
            }, delay); // Delay until result declaration
        })
        .catch(err => {
            console.error('Error fetching cycle data:', err);
        });
}



app.get("/activity", isLoggedIn, (req, res) => {
    res.render("activity/activity.ejs");
});

app.get("/wallet", isLoggedIn, (req, res) => {
    const balance = req.user.balance;
    res.render("wallet/wallet.ejs", { balance });
});
// main router 
app.use("/main", mainRouter);

app.get("/promotion", isLoggedIn, (req, res) => {
    res.render("promotion/promotion.ejs");
});
app.get("/logout", (req, res) => {
    req.logout((err) => {
        if (err) {
            return next(err);
        }
        req.flash("success", "you have been loged out");
        res.redirect("/home");

    })
});

app.get("/help", async (req, res) => {
    try {
        const info = await Info.findOne(); // Fetch the Info document
        if (!info) {
            return res.status(404).render('error', { message: 'Info not found' });
        }
        const telegramLink = info.telegramLink;
        res.render("help/help-center.ejs", { telegramLink });
    } catch (error) {
        console.error('Error fetching QR code:', error);
        res.status(500).render('error', { message: 'Internal server error' });
    }
});

app.get("/about", (req, res) => {
    res.render("conditions/about.ejs");
});

app.all("*", (req, res) => {
    res.redirect("/home");
})


app.listen(port, () => {
    console.log(`http://localhost:${port}`);
});
// when we declare result manually it shows result 5 sec before !error    