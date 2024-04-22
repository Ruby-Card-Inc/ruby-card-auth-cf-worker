import { Redis } from "@upstash/redis/cloudflare";

export default {
	async fetch(request, env) {
		try {
			const redis = new Redis({
				url: env.REDIS_URL, // Your Redis URL from environment variables
				token: env.REDIS_TOKEN // Your Redis token from environment variables
			});
			const requestBody = await request.json();

			const today = new Date();
			const yesterday = new Date(today);
			yesterday.setDate(yesterday.getDate() - 1);
			const todayDate = today.toISOString().split('T')[0]
			const yesterdayDate = yesterday.toISOString().split('T')[0]

			console.log('Printing Raw Body: ', requestBody)
			const transactionAmount = requestBody.amount.amount / 100

			const cardId = requestBody.card_id;
			const cardSpendControlCacheKey =
				'CARD-SPEND-CONTROL:SYNCTERA-ID:' + cardId
			const virtualCardSpendCacheKey =
				'CARD-SPEND-AGGREGATE:SYNCTERA-ID:' + cardId

			const [cardSpendControlCacheValue, virtualCardSpendAggregateCacheValue] = await redis.mget(
				cardSpendControlCacheKey,
				virtualCardSpendCacheKey
			);

			if (cardSpendControlCacheValue == null) {
				console.log(`Approve: No cardSpendControlCacheKey Found for: Card ID: ${cardId} with key ${cardSpendControlCacheKey}`)
				return new Response("No Spend Control", { status: 200 })
			}

			if (virtualCardSpendAggregateCacheValue === null) {
				console.log(`No virtualCardSpendAggregateCacheValue Found for: Card ID: ${cardId} with key ${cardSpendControlCacheKey}`)
				return new Response("No virtualCardSpendAggregateCacheValue Found", { status: 402 })
			}
			const virtualCardSpendAggregate = JSON.parse(virtualCardSpendAggregateCacheValue)
			const aggregateWeeklySum = virtualCardSpendAggregate.weeklySum
			const aggregateMonthlySum = virtualCardSpendAggregate.monthlySum
			const cardSpendControl = JSON.parse(cardSpendControlCacheValue)
			const spendControlTimeType = cardSpendControl.time_type
			const spendControlAmount = cardSpendControl.amount
			let [pendingTransactions, postedTransactions] = await Promise.all([
				getAllPendingCardTransactionsForCardForToday(cardId, yesterdayDate, env),
				getAllPostedCardTransactionsForCardForToday(cardId, yesterdayDate, env)
			]);
			pendingTransactions.results = pendingTransactions.results.filter(txn => txn.data.amount !== requestBody.amount.amount && txn.data.transaction_time !== requestBody.user_transaction_time)
			console.log(yesterdayDate)
			console.log('PENDING: ', pendingTransactions.results)
			console.log('POSTED: ', postedTransactions.results)
			let totalPendingSpend = calculateTotal(pendingTransactions.results, todayDate);
			let totalPostedSpend = calculateTotal(postedTransactions.results, todayDate);
			let totalSpendToday = totalPendingSpend + totalPostedSpend
			const totalSpendTodayInDecimal = totalSpendToday / 100;

			const totalWeeklySpend = totalSpendTodayInDecimal + aggregateWeeklySum
			const monthlySpend = totalSpendTodayInDecimal + aggregateMonthlySum

			const postTransactionTotalWeekly = totalWeeklySpend + transactionAmount
			const postTransactionTotalMonthly= monthlySpend + transactionAmount
			const postTransactionTotalDaily = totalSpendTodayInDecimal + transactionAmount

			console.log('yo', cardSpendControl, spendControlTimeType, spendControlAmount)

			if (spendControlTimeType === 'DAILY') {
				if ( postTransactionTotalDaily < spendControlAmount) {
					return new Response("", { status: 200 })
				} else {
					let errorMessage = `Total Above for Card: ${cardId} with total ${postTransactionTotalDaily} - type ${spendControlTimeType} and control ${spendControlAmount}`
					console.log(errorMessage)
					return new Response(errorMessage, { status: 402 })
				}

			} else if (spendControlTimeType === 'WEEKLY') {
				if (postTransactionTotalWeekly < spendControlAmount) {
					return new Response("", { status: 200 })
				} else {
					let errorMessage =`Total Above for Card: ${cardId} with total ${postTransactionTotalWeekly} - type ${spendControlTimeType} and control ${spendControlAmount}`
					console.log(errorMessage)
					return new Response(errorMessage, { status: 402 })
				}

			} else if (spendControlTimeType === 'MONTHLY') {
				if (postTransactionTotalMonthly < spendControlAmount) {
					return new Response("", { status: 200 })
				} else {
					let errorMessage =`Total Above for Card: ${cardId} with total ${postTransactionTotalMonthly} - type ${spendControlTimeType} and control ${spendControlAmount}`
					console.log(errorMessage)
					return new Response(errorMessage, { status: 402 })
				}
			}

			console.log("No Base Case Hit Error")
			return new Response("base case erroring out", { status: 402 })
		} catch (error) {
			console.log(error)
			return new Response(error.message, { status: 402 });
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
		url.searchParams.append('cachebust', Date.now());

		let response = await fetch(url, {
			method: options.method,
			headers: {
				Authorization: `Bearer ${env.SYNCTERA_API_KEY}`,
				'User-Agent': 'CF-Worker-API-Client/1.0',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			},
			cf: {
				cacheTtl: -1 // Bypass Cloudflare's cache
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
		params: { card_id: cardId, type: 'card', from_date: todayDate, limit: 100, exclude_jit_transactions: true  },
		method: 'GET'
	}, null, true, env);
}

async function getAllPostedCardTransactionsForCardForToday(cardId, todayDate, env) {
	return makeSyncteraRequest({
		url: `/v0/transactions/posted`,
		params: { card_id: cardId, type: 'card', from_date: todayDate, limit: 100, exclude_jit_transactions: true },
		method: 'GET'
	}, null, true, env);
}

