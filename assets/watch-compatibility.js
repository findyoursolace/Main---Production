let watches = [];
let selectedWatch = null;

async function getWatches() {
    try {
        const response = await fetch('https://pub-697dc9ec09b74369958d54a1cf851168.r2.dev/watches.json');
        return await response.json();
    } catch (error) {
        console.error('Error fetching R2 data:', error);
    }
}

document.addEventListener("DOMContentLoaded", async function () {
    let watchData = await getWatches();
    if (!watchData) return;

    watchData.forEach(object => {
        watches.push({
            "handle": object.handle,
            "id": object.id,
            "manufacturer": object.fields[0].value,
            "model": object.fields[1].value,
            "size": object.fields[2].value
        });
    });

    document.dispatchEvent(new Event('watchesLoaded'));
    console.log("Watches loaded", watches);
});