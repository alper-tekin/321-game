# 3-2-1 Futbol

İki kişilik, ayrı cihazlardan oynanan futbol bilgi oyunu. Geri sayımdan sonra iki oyuncu birer takım açıklar;
**iki takımda da oynamış** bir futbolcuyu ilk yazan puanı alır.

## Çalıştırma

```bash
npm install
npm start
```

Oyun `http://localhost:3210` adresinde açılır. Aynı Wi-Fi'daki telefondan bilgisayarın yerel IP adresiyle girilebilir.

## Veri

Kulüp ve oyuncu verisi [Wikidata](https://www.wikidata.org)'dan çekilir ve `data/football.json` dosyasına yazılır
(yaklaşık 1.600 kulüp, 100 bin oyuncu). Veriyi güncellemek için (birkaç dakika sürer):

```bash
npm run build-data
```

Wikidata bazen güncel transferleri geç işler. `data/overrides.json` dosyasıyla eksik kulüp kayıtları
elle eklenebilir (örn. Trossard'ın Beşiktaş transferi). Düzenledikten sonra `npm run build-data`
çalıştırın. Wikidata kaydı düzeldiğinde override'ı kaldırmak yeterli.

## Test

```bash
npm test
```

## Yayınlama

`render.yaml` ile [Render](https://render.com) ücretsiz planına yüklenebilir.
