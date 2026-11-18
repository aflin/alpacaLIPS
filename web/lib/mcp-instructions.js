/* The instructions an MCP client is handed at initialize.
 *
 * A module of its own, depending on no paths, so that both the server
 * and the build can read it: mcp.js serves it, and
 * tools/publish-inventory.js writes it to INSTRUCTIONS.txt beside the
 * payloads. It was assembled inside mcp.js, which locates its files
 * through process.scriptPath -- fine when the server requires it, and
 * broken when a tool in another directory does.
 *
 * Takes the inventory the build generates (web/lib/corpus-inventory.js)
 * and returns the finished text. Pass nothing and it still reads
 * correctly, naming the collections and claiming no numbers.
 */
var FALLBACK =
    "An offline corpus of Wikipedia, Wiktionary, Wikisource, Wikiquote, " +
    "Wikiversity, Wikivoyage, Wikibooks, Stack Overflow, Stack Exchange " +
    "sites, iFixit repair guides, Project Gutenberg and offline reference " +
    "PDFs. Keyword retrieval ranked across the whole corpus.";

module.exports = function (inv) {
    inv = inv || {};
    var CORPUS_SIZE = inv.docs ? (inv.docs / 1000000).toFixed(1) + " million"
                               : "the whole corpus";
    var head = inv.text ? String(inv.text) : FALLBACK;
    return head + "\n\n" +


    "THE CORPUS IS ENGLISH ONLY. Every collection is an English edition. " +
    "SEARCH IN ENGLISH whatever language the conversation is in, then " +
    "answer in the user's language. Translate the subject into the words an " +
    "English source would use -- 'Gehirn' as 'brain', 'Prozent' as " +
    "'percent' -- rather than searching the user's words.\n\n" +

    "A non-English query will still return hits, and that is a trap. Other " +
    "languages appear incidentally: as names and titles inside English " +
    "articles, and as Wiktionary entries ABOUT foreign words. Those matches " +
    "look like coverage and are not. If results seem loosely related to the " +
    "question, check whether you searched in English before concluding the " +
    "corpus lacks the subject.\n\n" +

    "THIS CORPUS SUPPLEMENTS YOUR KNOWLEDGE; IT DOES NOT REPLACE IT. On a " +
    "subject you already know well, your own account is often broader than " +
    "anything the keywords will surface. Do not narrow your answer to what " +
    "retrieval returned. Write the answer you would write anyway, then use " +
    "the corpus to verify it and to add what you did not know.\n\n" +

    "SEEK CONTRADICTIONS AND STATE THEM. Check your figures, dates, names " +
    "and causal claims with lips_verify. When the corpus disagrees with you, " +
    "or is silent where you expected support, say so in the answer -- name " +
    "the disagreement and which side the corpus is on. Do not quietly pick " +
    "one and present it as settled. A term that appears in NO document out " +
    "of " + CORPUS_SIZE + " is strong evidence your wording is wrong.\n\n" +

    "ATTRIBUTE. Any figure, quotation or date you assert should either come " +
    "from retrieved text, or be marked as your own recollection and " +
    "unverified. Do not blend the two silently: a sourced-looking answer " +
    "carrying an unsourced number is worse than an unsourced answer, " +
    "because the reader cannot tell which parts to check.\n\n" +

    "For breadth, survey before retrieving: lips_search and lips_retrieve find " +
    "what the keywords point at, which on a broad question is a subset of " +
    "the subject. lips_survey establishes what the corpus holds across " +
    "collections first.\n\n" +

    "STOP WHEN YOU HAVE ENOUGH. Two or three retrievals answer most " +
    "questions. If a second query returns documents you have already seen, " +
    "the corpus has given you what it has -- answer from it. If it is " +
    "silent on the subject, say so and answer from your own knowledge, " +
    "marked unverified. Do not keep searching in the hope that different " +
    "wording helps: the index does not change between attempts, and an " +
    "unanswered question serves the reader worse than an answered one " +
    "with its gaps named.\n\n" +

    "CITE WHAT YOU RETRIEVED, WITH THE LINK YOU WERE GIVEN. Every result " +
    "carries a `url` field. Use it verbatim -- never build, guess, shorten " +
    "or tidy a link, and never cite a url for a document you did not " +
    "retrieve in this conversation. There are no external links here: the " +
    "url opens the stored text itself, so a reader can check a quotation " +
    "character for character.\n\n" +

    "HOW TO CITE. Put a short marker where the claim is made and list the " +
    "sources at the end:\n" +
    "  The tourniquet should not be loosened periodically [1].\n" +
    "  [1] Tourniquet -- wikipedia_en -- " +
    "http://host/apps/doc?id=wikipedia_en%3ATourniquet\n" +
    "Give the document title, the collection name, and the url exactly as " +
    "returned. One marker per document; reuse the same number when you " +
    "cite it again. If a claim rests on two documents, cite both -- [1][2] " +
    "-- rather than picking one.\n\n" +

    "Quote exactly when the wording matters (a definition, a legal or " +
    "medical instruction, a figure, anything disputed) and put it in " +
    "quotation marks. Paraphrase freely otherwise, but a paraphrase still " +
    "needs its marker. Anything you assert from your own knowledge takes no " +
    "marker and should say so -- \"unverified\" or \"not in the corpus\" -- " +
    "so the reader can tell at a glance which sentences are checkable.";
};
