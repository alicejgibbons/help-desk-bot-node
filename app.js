require('dotenv').config();
const ticketsApi = require('./ticketsApi');
const restify = require('restify');
const builder = require('botbuilder');
const fs = require('fs');

const listenPort = process.env.port || process.env.PORT || 3978;
const ticketSubmissionUrl = process.env.TICKET_SUBMISSION_URL || `http://localhost:${listenPort}`;

const azureSearch = require('./azureSearchApiClient');
const azureSearchQuery = azureSearch({
    searchName: process.env.AZURE_SEARCH_ACCOUNT,
    indexName: process.env.AZURE_SEARCH_INDEX,
    searchKey: process.env.AZURE_SEARCH_KEY
});

// Setup Restify Server
var server = restify.createServer();
server.listen(listenPort, '::', () => {
    console.log('Server Up');
});

// Setup body parser and tickets api
server.use(restify.bodyParser());
server.post('/api/tickets', ticketsApi);

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

// Listen for messages from users
server.post('/api/messages', connector.listen());

var bot = new builder.UniversalBot(connector, (session) => {
    session.endDialog(`I'm sorry, I did not understand '${session.message.text}'.\nType 'help' to know more about me :)`);
});

// Add LUIS capabilities
var luisRecognizer = new builder.LuisRecognizer(process.env.LUIS_MODEL_URL).onEnabled(function (context, callback) {
    var enabled = context.dialogStack().length === 0;
    callback(null, enabled);
});
bot.recognizer(luisRecognizer);

bot.dialog('Help',
(session, args, next) => {
    session.endDialog(`I'm the help desk bot and I can help you create a ticket or explore the knowledge base.\n` +
        `You can tell me things like _I need to reset my password_ or _explore hardware articles_.`);
}
).triggerAction({
matches: 'Help'
});

bot.dialog('SubmitTicket', [
    (session, args, next) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');
        var severity = builder.EntityRecognizer.findEntity(args.intent.entities, 'severity');
    
        if (category && category.resolution.values.length > 0) {
            session.dialogData.category = category.resolution.values[0];
        }
    
        if (severity && severity.resolution.values.length > 0) {
            session.dialogData.severity = severity.resolution.values[0];
        }
    
        session.dialogData.description = session.message.text;
    
        if (!session.dialogData.severity) {
            var choices = ['high', 'normal', 'low'];
            builder.Prompts.choice(session, 'Which is the severity of this problem?', choices, { listStyle: builder.ListStyle.button });
        } else {
            next();
        }
    },
    (session, result, next) => {
        if (!session.dialogData.severity) {
            session.dialogData.severity = result.response.entity;
        }
    
        if (!session.dialogData.category) {
            builder.Prompts.text(session, 'Which would be the category for this ticket (software, hardware, network, and so on)?');
        } else {
            next();
        }
    },
    (session, result, next) => {
        if (!session.dialogData.category) {
            session.dialogData.category = result.response;
        }
    
        var message = `Great! I'm going to create a "${session.dialogData.severity}" severity ticket in the "${session.dialogData.category}" category. ` +
                      `The description I will use is "${session.dialogData.description}". Can you please confirm that this information is correct?`;
    
        builder.Prompts.confirm(session, message, { listStyle: builder.ListStyle.button });
    },
    (session, result, next) => {
        if (result.response) {
            var data = {
                category: session.dialogData.category,
                severity: session.dialogData.severity,
                description: session.dialogData.description,
            }
    
            const client = restify.createJsonClient({ url: ticketSubmissionUrl });
    
            client.post('/api/tickets', data, (err, request, response, ticketId) => {
                if (err || ticketId == -1) {
                    session.send('Something went wrong while I was saving your ticket. Please try again later.')
                } else {
                    session.send(new builder.Message(session).addAttachment({
                        contentType: "application/vnd.microsoft.card.adaptive",
                        content: createCard(ticketId, data)
                    }));
                }
    
                session.endDialog();
            });
        } else {
            session.endDialog('Ok. The ticket was not created. You can start again if you want.');
        }
    }
 ])
 .triggerAction({
     matches: 'SubmitTicket'
 });

 // Search the knowledge base by category
 bot.dialog('ExploreKnowledgeBase', [
    (session, args, next) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');

        if (!category) {
            // retrieve facets
            azureSearchQuery('facet=category', (error, result) => {
                if (error) {
                    session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                } else {
                    var choices = result['@search.facets'].category.map(item=> `${item.value} (${item.count})`);
                    builder.Prompts.choice(session, 'Let\'s see if I can find something in the knowledge base for you. Which category is your question about?', choices, { listStyle: builder.ListStyle.button });
                }
            });
        } else {
            if (!session.dialogData.category) {
                session.dialogData.category = category.entity;
            }

            next();
        }
    }, (session, args) => {
        var category;
    
        if (session.dialogData.category) {
            category = session.dialogData.category;
        } else {
            category = args.response.entity.replace(/\s\([^)]*\)/,'');
        }
    
        // search by category
        azureSearchQuery('$filter=' + encodeURIComponent(`category eq '${category}'`), (error, result) => {
            if (error) {
                session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
            } else {
                session.replaceDialog('ShowKBResults', { result, originalText: category });
            }
        });
    }
]).triggerAction({
    matches: 'ExploreKnowledgeBase'
});

// Search for specific articles in knowledge base
bot.dialog('SearchKB', [
    (session) => {
        session.sendTyping();
        azureSearchQuery(`search=${encodeURIComponent(session.message.text.substring('search about '.length))}`, (err, result) => {
            if (err) {
                session.send('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                return;
            }
            session.replaceDialog('ShowKBResults', { result, originalText: session.message.text });
        });
    }
])
.triggerAction({
    matches: /^search about (.*)/i
});

// Show results of Search as thumbnails
bot.dialog('ShowKBResults', [
    (session, args) => {
        if (args.result.value.length > 0) {
            var msg = new builder.Message(session).attachmentLayout(builder.AttachmentLayout.carousel);
            args.result.value.forEach((faq, i) => {
                msg.addAttachment(
                    new builder.ThumbnailCard(session)
                        .title(faq.title)
                        .subtitle(`Category: ${faq.category} | Search Score: ${faq['@search.score']}`)
                        .text(faq.text.substring(0, Math.min(faq.text.length, 50) + '...'))
                        .images([builder.CardImage.create(session, 'https://bot-framework.azureedge.net/bot-icons-v1/bot-framework-default-7.png')])
                        .buttons([{ title: 'More details', value: `show me the article ${faq.title}`, type: 'postBack' }])
                );
            });
            session.send(`These are some articles I\'ve found in the knowledge base for _'${args.originalText}'_, click **More details** to read the full article:`);
            session.endDialog(msg);
        } else {
            session.endDialog(`Sorry, I could not find any results in the knowledge base for _'${args.originalText}'_`);
        }
    }
]);

// Retrieve a specific article based on it's title
bot.dialog('DetailsOf', [
    (session, args) => {
        var title = session.message.text.substring('show me the article '.length);
        azureSearchQuery('$filter=' + encodeURIComponent(`title eq '${title}'`), (error, result) => {
            if (error || !result.value[0]) {
                session.endDialog('Sorry, I could not find that article.');
            } else {
                session.endDialog(result.value[0].text);
            }
        });
    }
]).triggerAction({
    matches: /^show me the article (.*)/i
});


// Create support ticket
const createCard = (ticketId, data) => {
    var cardTxt = fs.readFileSync('./cards/ticket.json', 'UTF-8');

    cardTxt = cardTxt.replace(/{ticketId}/g, ticketId)
                    .replace(/{severity}/g, data.severity)
                    .replace(/{category}/g, data.category)
                    .replace(/{description}/g, data.description);

    return JSON.parse(cardTxt);
};
