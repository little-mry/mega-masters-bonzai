Länk till postman collection: https://bold-comet-596367.postman.co/workspace/Alice-workspace~8c349ba3-f3ac-4d9e-82fc-c37198d4b448/collection/43237590-0a28ca3c-2cf6-4426-91a6-7081d0faf65b?action=share&creator=43237590

Vår GitHub: https://github.com/little-mry/mega-masters-bonzai

Figma med datamodell: https://www.figma.com/board/oiBqGBCBM8oDuV33yt4WxM/Mega-Masters-Bonzai?node-id=0-1&p=f&t=9SXzJQQelEG658CN-0

Bakgrund

Bonz.ai, företaget bakom hotellet, har alltid strävat efter att vara i framkant när det gäller att använda teknik för att förbättra kundupplevelsen. De har en stark kultur av innovation och är inte rädda för att tänka utanför boxen.

Ni har blivit anlitade för att bygga deras boknings-API, valet i detta projekt föll på en serverless arkitektur i AWS. Detta innebär att ni inte behöver oroa sig för att hantera eller underhålla servrar. Istället kan ni fokusera på att bygga och förbättra er applikation. Dessutom gör serverless arkitektur det möjligt för Bonz.ai att skala upp eller ned baserat på efterfrågan, vilket är perfekt för deras bokningssystem som kan ha olika trafik vid olika tider på dagen eller året. ☁️

För att lagra all bokningsinformation har DynamoDB valts, en NoSQL databas som erbjuds av AWS. DynamoDB är en utmärkt val för deras boknings-API eftersom den erbjuder snabb och förutsägbar prestanda samt automatisk skalning.
Instruktioner
Kravspecifikation och user stories

User stories: https://github.com/orgs/JS22-backend-fordjupning/projects/2/views/1

Affärslogik

Rum

    Det finns totalt 20 rum på hotellet som kan bokas dock behöver man inte ta hänsyn till datum (men man får).
    Det finns tre typer av rum:
        Enkelrum som tillåter enbart en 1 gäst
        Dubbelrum som tillåter 2 gäster
        Svit som tillåter 3 gäster
    Enkelrum kostar 500 kr / natt
    Dubbelrum kostar 1000 kr / natt
    Svit kostar 1500 kr / natt
    Det går att ha olika typer av rum i en bokning men antalet gäster måste stämma överens med ovan logik. Exempel: 3 personer behöver antingen boka en svit eller ett enkelrum och ett dubbelrum.

Tekniska krav

    Serverless framework
    API Gateway
    AWS Lambda
    DynamoDB
    Det finns felhantering ifall något går fel mot DynamoDB och ifall man försöker skicka in fel värden från body.

Betygskriterier

För Godkänt:

    Uppfyller alla krav i kravspecifikationen.
    Uppfyller alla tekniska krav.