export default {
	async fetch(request, env) {
		try {
			const requestBody = await request.json();
			const cardId = requestBody.card_id;
			const today = new Date();
			const yesterday = new Date(today);
			yesterday.setDate(yesterday.getDate() - 1);

			const todayDate = today.toISOString().split('T')[0]
			const yesterdayDate = yesterday.toISOString().split('T')[0]
			const [pendingTransactions, postedTransactions] = await Promise.all([
				getAllPendingCardTransactionsForCardForToday(cardId, yesterdayDate, env),
				getAllPostedCardTransactionsForCardForToday(cardId, yesterdayDate, env)
			]);


			let totalPendingSpend = calculateTotal(pendingTransactions.results, todayDate);
			let totalPostedSpend = calculateTotal(postedTransactions.results, todayDate);
			let totalSpendToday = totalPendingSpend + totalPostedSpend

			console.log("totalPendingTXN: " + pendingTransactions.results)
			console.log("totalPostedTXN : " + postedTransactions.results)
			console.log("totalSpendToday : " + totalPendingSpend)
			console.log("totalPostedSpend : " + totalPostedSpend)
			const totalSpendTodayInDecimal = totalSpendToday / 100;
			return new Response(JSON.stringify({ totalSpendTodayInDecimal }), { status: 200 });
		} catch (error) {
			console.log(error)
			console.log(JSON.stringify(error))
			return new Response(error.message, { status: 500 });
		}
	}
};

function calculateTotal(transactions, todayDate) {
	return transactions.reduce((sum, transaction) => {
		let onlyDate = transaction.data.user_data.transaction_date.split('T')[0];
		let subType = transaction.data.subtype ?? transaction.subtype
		if (subType === 'pos_purchase' && onlyDate === todayDate) {
			sum += transaction.data.user_data.amount;
		}
		return sum;
	}, 0);
}

async function makeSyncteraRequest(options, errorMessage = '', followNextLinks = false, env) {
	try {
		let url = new URL(options.url, env.SYNCTERA_BASE_URL);
		url.search = new URLSearchParams(options.params).toString();

		let response = await fetch(url, {
			method: options.method,
			headers: {
				Authorization: `Bearer ${env.SYNCTERA_API_KEY}`,
				'User-Agent': 'CF-Worker-API-Client/1.0'
			}
		});

		let data = await response.json();
		let responses = [data];

		while (followNextLinks && data.next_page_token) {
			url.searchParams.set('page_token', data.next_page_token);
			response = await fetch(url, options);
			data = await response.json();
			responses.push(data);
		}

		return followNextLinks
			? { results: responses.flatMap(obj => obj.result) }
			: data;
	} catch (err) {
		console.log(err)
		throw new Error(errorMessage || 'An error occurred');
	}
}

async function getAllPendingCardTransactionsForCardForToday(cardId, todayDate, env) {
	return makeSyncteraRequest({
		url: `/v0/transactions/pending`,
		params: { card_id: cardId, type: 'card', from_date: todayDate, limit: 100 },
		method: 'GET'
	}, null, true, env);
}

async function getAllPostedCardTransactionsForCardForToday(cardId, todayDate, env) {
	return makeSyncteraRequest({
		url: `/v0/transactions/posted`,
		params: { card_id: cardId, type: 'card', from_date: todayDate, limit: 100 },
		method: 'GET'
	}, null, true, env);
}

