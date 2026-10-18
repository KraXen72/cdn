const filter = document.querySelector('.filter');
const input = filter.querySelector('input');
const status = document.querySelector('#filter-status');
const categories = Array.from(document.querySelectorAll('.category'), section => ({
    section,
    list: section.querySelector('ul'),
    entries: Array.from(section.querySelectorAll('li'), item => {
        const link = item.querySelector('a');
        const name = link.textContent;
        return { item, link, name, searchName: name.toLowerCase() };
    }),
}));

/** Highlight literal matches using text nodes so queries cannot become markup. */
function highlightMatches(entry, query) {
    entry.link.textContent = '';
    let offset = 0;
    let match;

    while (query && (match = entry.searchName.indexOf(query, offset)) !== -1) {
        entry.link.append(entry.name.slice(offset, match));
        const mark = document.createElement('mark');
        mark.textContent = entry.name.slice(match, match + query.length);
        entry.link.append(mark);
        offset = match + query.length;
    }

    entry.link.append(entry.name.slice(offset));
}

function filterLinks() {
    const query = input.value.trim().toLowerCase();
    let totalMatches = 0;

    for (const { section, list, entries } of categories) {
        const matches = entries.filter(entry => entry.searchName.includes(query));
        // Stable sorting keeps the original order within each match group.
        matches.sort((a, b) =>
            Number(b.searchName.startsWith(query)) - Number(a.searchName.startsWith(query))
        );

        for (const entry of matches) {
            highlightMatches(entry, query);
        }

        list.replaceChildren(...matches.map(entry => entry.item));
        section.hidden = matches.length === 0;
        totalMatches += matches.length;
    }

    status.textContent = totalMatches === 0 ? 'No matching links.' : '';
}

input.addEventListener('input', filterLinks);
filter.hidden = false;
filterLinks();
