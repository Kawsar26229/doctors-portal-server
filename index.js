const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 5000;
const app = express();

// Middleware
app.use(cors())
app.use(express.json())

app.use('/', (req, res) => {
    res.json({message: 'Hello from express App'})
})


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.271e7ea.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// Middleware
function verifyJWT(req, res, next){
    const authHeader = req.headers.authorization;
    if(!authHeader) {
        return res.status(401).send('unauthorized access')
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function(err, decoded) {
        if(err) {
            return res.status(403).send({message: 'forbidden access'})
        }
        req.decoded = decoded;
        next();
    })
}

async function run() {
    try {
        const appointmentOptionCollection = client.db('doctorsPortal').collection('appointmentOptions');
        const bookingCollection = client.db('doctorsPortal').collection('bookings');
        const userCollection = client.db('doctorsPortal').collection('users');
        const doctorCollection = client.db('doctorsPortal').collection('doctos');
        const paymentCollection = client.db('doctorsPortal').collection('payments');

        //TODO: Middleware (verify admin after verifyJWT)
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = {email: decodedEmail};
            const user = await userCollection.findOne(query);
            if(user?.role !== 'admin') {
                return res.status(403).send('forbidden access')
            }
            next();
        }

        app.get('/appointmentOptions', async(req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appointmentOptionCollection.find(query).toArray();
            const bookingQuery = {appointmentDate: date}
            const alreadyBooked = await bookingCollection.find(bookingQuery).toArray();
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot)
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;
            })
            res.send(options)
        })

        app.get('/appointmentSpecialty', async(req, res) => {
            const query = {};
            const result = await appointmentOptionCollection.find(query).project({name: 1}).toArray();
            res.send(result);
        })
        
        app.get('/bookings', verifyJWT, async(req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if(email !== decodedEmail) {
                return res.status(403).send({message: 'forbidden access'})
            }
            const query = {email: email};
            const bookings = await bookingCollection.find(query).toArray();
            res.send(bookings);
        })

        app.get('/bookings/:id', async(req, res) => {
            const id = req.params.id;
            const query = {_id: new ObjectId(id)};
            const booking = await bookingCollection.findOne(query);
            res.send(booking)
        })

        app.post('/bookings', async(req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }
            const alreadyBooked = await bookingCollection.find(query).toArray();
            if(alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`;
                return res.send({acknowledged: false, message})
            }
            const result = await bookingCollection.insertOne(booking);
            res.send(result)
        })

        // Payment Methods
        app.post('/create-payment-intent', async(req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                "payment_method_types": [
                    "card"
                ]
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
              });
        })

        app.post('/payments', async(req, res) => {
            const payemt = req.body;
            const result = await paymentCollection.insertOne(payemt);
            const id = payemt.bookingId;
            const filter = {_id: new ObjectId(id)};
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payemt.transactionId
                }
            }
            const updatedResult = await bookingCollection.updateOne(filter, updatedDoc)
            res.send(updatedResult);
        })

        app.get('/jwt', async(req, res) => {
            const email = req.query.email;
            const query = {email: email};
            const user = await userCollection.findOne(query);
            if(user) {
                const token = jwt.sign({email}, process.env.ACCESS_TOKEN, {expiresIn: '1hr'})
                return res.send({accessToken: token});
            }
            res.status(403).send({accessToken: ''})
        })

        app.get('/users', async(req, res) => {
            const query = {};
            const users = await userCollection.find(query).toArray();
            res.send(users);
        })

        app.get('/users/admin/:email', async(req, res) => {
            const email = req.params.email;
            const query = {email: email};
            const user = await userCollection.findOne(query);
            res.send({isAdmin: user?.role === 'admin'})
        })

        app.post('/users', async(req, res) => {
            const user = req.body;
            const result = await userCollection.insertOne(user);
            res.send(result);
        })

        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async(req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await userCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        })

        // temporary to update price field on appointment options
        // app.get('/addPrice', async(req, res) => {
        //     const filter = {};
        //     const options = {upsert: true};
        //     const updatedDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options)
        //     res.send(result)
        // })

        app.get('/doctors', verifyJWT, verifyAdmin, async(req, res) => {
            const query = {};
            const doctors = await doctorCollection.find(query).toArray();
            res.send(doctors)
        })

        app.post('/doctors', verifyJWT, verifyAdmin, async(req, res) => {
            const doctor = req.body;
            const result = await doctorCollection.insertOne(doctor);
            res.send(result)
        })

        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async(req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const result = await doctorCollection.deleteOne(filter);
            res.send(result);
        })

    }
    finally {

    }
}
run().catch(console.log())

app.get('/appointmentOptions', async(req, res) => {
    res.send('Hello World!')
  })
  

app.listen(port, () => {
    console.log(`Doctors Portal is running on port ${port
    }`);
})