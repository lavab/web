module.exports = ($http, $q) => {
	const Levenshtein = window.Levenshtein;
	const words = {};

	return {
		require: 'ngModel',
		link: (scope, elem, attrs, ngModel) => {
			const dictionary = attrs.dictionary;
			const minLevenshteinDistance = attrs.minLevenshteinDistance;

			ngModel.$asyncValidators.dictionary = (modelValue, viewValue) => {
				if (!words[dictionary])
					words[dictionary] = $http.get(dictionary)
						.then(r => r.data.split('\n'));

				return words[dictionary]
					.then(words => {
						for (let word of words) {
							word = word.trim();
							let levenshtein = new Levenshtein(word, viewValue);
							if (levenshtein.distance < minLevenshteinDistance)
								return $q.reject(false);
						}

						return true;
					});
			};
		}
	};
};